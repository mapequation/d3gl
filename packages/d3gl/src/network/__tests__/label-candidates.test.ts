import { describe, it, expect } from "vitest";
import { CandidateList, descendingInListOrder } from "../label-candidates.js";

/** The LOD label ranking it replaces: a stable comparator sort of the in-view frontier by importance. */
function stableSortReference(ids: number[], keyOf: (id: number) => number): number[] {
  return [...ids].sort((a, b) => keyOf(b) - keyOf(a));
}

function listOf(ids: number[]): CandidateList {
  const list = new CandidateList();
  for (const id of ids) list.push(id);
  return list;
}

function drain(next: () => number): number[] {
  const out: number[] = [];
  for (let id = next(); id >= 0; id = next()) out.push(id);
  return out;
}

describe("descendingInListOrder (LOD label top-k)", () => {
  it("pops importance-descending with ties in list order — the stable sort's exact sequence", () => {
    let s = 5 >>> 0;
    const rng = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    // Frontier order is NOT id order: a shuffled id set, with many tied importances.
    const ids = Array.from({ length: 5_000 }, (_, i) => i * 3 + 1);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [ids[i], ids[j]] = [ids[j] ?? 0, ids[i] ?? 0];
    }
    const importance = new Map(ids.map((id) => [id, Math.floor(rng() * 40)]));
    const keyOf = (id: number): number => importance.get(id) ?? 0;
    const got = drain(descendingInListOrder(listOf(ids), keyOf, new CandidateList()));
    expect(got).toEqual(stableSortReference(ids, keyOf));
  });

  it("evaluates the importance accessor once per candidate (the comparator sort ran it ~2·log₂C times each)", () => {
    const ids = Array.from({ length: 20_000 }, (_, i) => (i * 7919) % 20_000);
    let calls = 0;
    const keyOf = (id: number): number => {
      calls++;
      return id % 97;
    };
    const next = descendingInListOrder(listOf(ids), keyOf, new CandidateList());
    for (let k = 0; k < 50; k++) next(); // a `max: 50` cap stops after ~50 pops
    expect(calls).toBe(ids.length);
  });

  it("leaves the candidate list untouched and reuses the rank scratch", () => {
    const ids = [9, 4, 7, 4, 1];
    const list = listOf(ids);
    const rank = new CandidateList();
    expect(drain(descendingInListOrder(list, (id) => id, rank))).toEqual([9, 7, 4, 4, 1]);
    expect(Array.from(list.ids.subarray(0, list.length))).toEqual(ids);
    const storage = rank.ids;
    drain(descendingInListOrder(list, (id) => -id, rank));
    expect(rank.ids).toBe(storage);
  });
});
