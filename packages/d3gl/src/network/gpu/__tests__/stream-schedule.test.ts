/**
 * The streaming layout's work items (#382): which bands of which passes a frame encodes — node, pure, with a
 * fake budget. Every pass is cut into the bands its budget asks for, each band is one item, a readback's
 * passes run exclusively before its copy — its start reported when it starts, frames before the copy when
 * the budget holds its passes back — a pass keeps the band count it started with, and a tick under way can be
 * dropped (#376: the frozen tick a convergence stop goes idle in).
 */
import { describe, expect, it } from "vitest";
import { stageBands } from "../frame-budget.js";
import { StreamSchedule, type ScheduleBudget, type StreamStage } from "../stream-schedule.js";

/** A budget of `budgetMs` per frame: admits items while their sum fits, a frame's first always. */
class FakeBudget implements ScheduleBudget {
  budgetMs: number;
  frameMs = 0;
  items = 0;
  constructor(budgetMs: number) {
    this.budgetMs = budgetMs;
  }
  bandsFor(costMs: number, rows: number, fixedMs = 0): number {
    return stageBands(costMs, this.budgetMs, rows, 1, fixedMs);
  }
  admit(costMs: number): boolean {
    return this.items === 0 || this.frameMs + costMs <= this.budgetMs;
  }
  spent(costMs: number): void {
    this.frameMs += costMs;
    this.items++;
  }
  newFrame(): void {
    this.frameMs = 0;
    this.items = 0;
  }
}

type Event = string;

function stage(name: string, costMs: number, rows: number, log: Event[], fixedMs = 0): StreamStage {
  return { costMs, fixedMs, rows, run: (band, bands) => log.push(`${name}${band}/${bands}`) };
}

interface Rig {
  budget: FakeBudget;
  log: Event[];
  schedule: StreamSchedule;
  ticks: number;
  copies: boolean[];
}

function rig(budgetMs: number, tick: (log: Event[]) => StreamStage[], readback: (log: Event[]) => StreamStage[]): Rig {
  const log: Event[] = [];
  const budget = new FakeBudget(budgetMs);
  const tickStages = tick(log);
  const readbackStages = readback(log);
  const r: Rig = {
    budget,
    log,
    ticks: 0,
    copies: [],
    schedule: new StreamSchedule(budget, { tickStages: () => tickStages, readbackStages: () => readbackStages }, {
      tickStart: () => log.push("start"),
      tickEnd: () => {
        log.push("end");
        r.ticks++;
      },
      readbackStart: () => log.push("read"),
      copy: (betweenTicks) => {
        log.push("copy");
        r.copies.push(betweenTicks);
      },
    }),
  };
  return r;
}

/** One frame: the owner's calls around the schedule. */
function frame(r: Rig, opts: { open?: boolean; ticks?: number; copy?: boolean } = {}): number {
  r.budget.newFrame();
  r.log.push("|");
  const limit = opts.ticks ?? Infinity;
  return r.schedule.frame(opts.open ?? true, () => r.ticks < limit, () => opts.copy === true);
}

describe("StreamSchedule (#382)", () => {
  it("cuts each pass into the bands the budget asks for, one item per band, in order", () => {
    // At 10 ms: a 12 ms pass → ⌈12 / 5⌉ = 3 bands of 4 ms; 1 ms passes stay whole.
    const r = rig(10, (log) => [stage("P", 1, 1, log), stage("F", 12, 100, log), stage("I", 1, 1, log)], () => []);
    const items = [frame(r, { ticks: 1 }), frame(r, { ticks: 1 })];
    expect(r.log.join(" ")).toBe("| start P0/1 F0/3 F1/3 | F2/3 I0/1 end");
    expect(items).toEqual([3, 2]); // 1 + 4 + 4 ≤ 10 < 1 + 4 + 4 + 4; then the tick ends
    expect(r.ticks).toBe(1);
  });

  it("keeps a pass's band count from its first band, whatever the budget becomes", () => {
    const r = rig(10, (log) => [stage("F", 12, 100, log)], () => []);
    frame(r, { ticks: 1 }); // F0/3, F1/3 (4 + 4 ≤ 10)
    r.budget.budgetMs = 5; // 120 Hz now: a new pass would get 5 bands
    frame(r, { ticks: 1 });
    expect(r.log.join(" ")).toBe("| start F0/3 F1/3 | F2/3 end");
  });

  it("runs a readback's passes exclusively, over as many frames as they need, then copies", () => {
    // Readback passes of 4 ms each at a 5 ms budget: one per frame; no tick band until the copy.
    const r = rig(5, (log) => [stage("T", 1, 1, log)], (log) => [stage("R", 4, 1, log), stage("S", 4, 1, log)]);
    const five = "start T0/1 end start T0/1 end start T0/1 end start T0/1 end start T0/1 end";
    frame(r, { ticks: 100, copy: true }); // ticks fill the frame (1 ms each: 5 items); R does not fit after them
    frame(r, { ticks: 100 }); // R alone: the readback goes first, and nothing runs beside it
    frame(r, { ticks: 100 }); // S, the copy, then ticks again in what is left
    frame(r, { ticks: 100 });
    // The readback started in the first frame — two frames before its copy.
    expect(r.log.join(" ")).toBe(`| ${five} read | R0/1 | S0/1 copy start T0/1 end | ${five}`);
    expect(r.copies).toEqual([true]); // between ticks
  });

  it("copies at once when the readback needs no passes, even in a frame the gate kept closed", () => {
    const r = rig(10, (log) => [stage("P", 1, 1, log), stage("I", 1, 1, log)], () => []);
    frame(r, { ticks: 1, copy: false });
    expect(r.log.join(" ")).toBe("| start P0/1 I0/1 end");
    expect(frame(r, { open: false, ticks: 2, copy: true })).toBe(0);
    expect(r.log.slice(-3).join(" ")).toBe("| read copy");
  });

  it("tells the copy whether a tick is under way", () => {
    // A 2-band pass of 5 ms bands at 10 ms: the frame ends mid-tick; the copy follows that frame's items.
    const r = rig(10, (log) => [stage("F", 20, 100, log)], () => []);
    frame(r, { ticks: 1, copy: true });
    expect(r.log.join(" ")).toBe("| start F0/4 F1/4 read copy");
    expect(r.copies).toEqual([false]);
  });

  it("never runs a readback's pass in a closed frame, and resumes it when the gate opens", () => {
    const r = rig(10, (log) => [stage("T", 1, 1, log)], (log) => [stage("R", 1, 1, log)]);
    frame(r, { open: false, ticks: 1, copy: true });
    expect(r.schedule.reading).toBe(true);
    expect(r.log.join(" ")).toBe("| read");
    frame(r, { ticks: 1 });
    expect(r.log.join(" ")).toBe("| read | R0/1 copy start T0/1 end");
    expect(r.schedule.reading).toBe(false);
  });

  it("reads a tick's stages once, before its first band, however many frames its first band waits", () => {
    // A source whose every read is the next tick (T0, T1, …): 4 ms passes at a 5 ms budget, so a frame's first
    // item is a whole tick and the next tick's first band waits for the next frame — for two frames once a
    // readback's pass goes first. Read again while it waits, a tick would be skipped.
    const log: Event[] = [];
    const budget = new FakeBudget(5);
    let reads = 0;
    let ends = 0;
    const readback = [stage("R", 4, 1, log)];
    const schedule = new StreamSchedule(budget, { tickStages: () => [stage(`T${reads++}.`, 4, 1, log)], readbackStages: () => readback }, {
      tickStart: () => {},
      tickEnd: () => {
        ends++;
      },
      readbackStart: () => log.push("read"),
      copy: () => log.push("copy"),
    });
    const run = (copy: boolean): void => {
      budget.newFrame();
      log.push("|");
      schedule.frame(true, () => ends < 4, () => copy);
    };
    for (const copy of [false, true, false, false, false, false]) run(copy);
    expect(log.join(" ")).toBe("| T0.0/1 | T1.0/1 read | R0/1 copy | T2.0/1 | T3.0/1 |");
    expect(reads).toBe(4);
  });

  it("drops the tick under way: the next tick starts at its first pass, from its stages read afresh (#376)", () => {
    // A 3-band pass of 4 ms bands at 10 ms: the frame ends after P and two bands, mid-tick.
    let kind = "a";
    const log: Event[] = [];
    const budget = new FakeBudget(10);
    const ticks = { a: [stage("P", 1, 1, log), stage("F", 12, 100, log), stage("I", 1, 1, log)], b: [stage("Q", 1, 1, log)] };
    let ends = 0;
    const schedule = new StreamSchedule(budget, { tickStages: () => (kind === "a" ? ticks.a : ticks.b) }, {
      tickStart: () => log.push("start"),
      tickEnd: () => {
        log.push("end");
        ends++;
      },
      readbackStart: () => log.push("read"),
      copy: () => log.push("copy"),
    });
    const run = (): number => {
      budget.newFrame();
      log.push("|");
      return schedule.frame(true, () => ends < 2, () => false);
    };
    run();
    expect(schedule.tickStarted).toBe(true);
    schedule.dropTick();
    expect(schedule.tickStarted).toBe(false);
    kind = "b"; // a new tick reads its stages afresh: the dropped one's are never finished
    run();
    run();
    expect(log.join(" ")).toBe("| start P0/1 F0/3 F1/3 | start Q0/1 end start Q0/1 end |");
    expect(ends).toBe(2); // the dropped tick never ended
    schedule.dropTick(); // between ticks: nothing to drop
    expect(schedule.tickStarted).toBe(false);
  });
});
