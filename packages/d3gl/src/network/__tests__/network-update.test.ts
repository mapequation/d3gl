import { describe, it, expect } from "vitest";
import { planNetworkUpdate, type ModuleHierarchy } from "../network-update.js";
import type { ModuleLink, ModuleNode } from "../modules.js";

/**
 * The checks `update()` and `data()` share (#547): one pure step that validates a change against the loaded network
 * and returns it, or throws before anything changes.
 */
const MODULES: ModuleNode[] = [
  { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
];
const PAIRS: ModuleNode[] = [
  { id: 0, path: [1, 1] }, { id: 1, path: [2, 1] }, { id: 2, path: [1, 2] }, { id: 3, path: [2, 2] },
];
const LINKS: ModuleLink[] = [{ source: [1], target: [2], flow: 0.5 }];

function held(): ModuleHierarchy {
  return planNetworkUpdate("t", 4, { modules: MODULES, moduleLinks: LINKS }, null).hierarchy ?? fail();
}
function fail(): never {
  throw new Error("expected a hierarchy");
}

describe("planNetworkUpdate (#547)", () => {
  it("leaves out what is not given: no flow, the hierarchy unchanged", () => {
    expect(planNetworkUpdate("t", 4, {}, held())).toEqual({ flow: undefined, hierarchy: undefined });
  });

  it("copies the flow, never keeping the caller's array", () => {
    const flow = [0.1, 0.2, 0.3, 0.4];
    const plan = planNetworkUpdate("t", 4, { flow }, null);
    expect(plan.flow).toBeInstanceOf(Float32Array);
    expect(Array.from(plan.flow ?? [])).toEqual(Array.from(Float32Array.from(flow)));
    const typed = new Float32Array(4);
    expect(planNetworkUpdate("t", 4, { flow: typed }, null).flow).not.toBe(typed);
  });

  it("throws on a flow of the wrong length", () => {
    expect(() => planNetworkUpdate("network.update", 4, { flow: [1, 2, 3] }, null)).toThrow(/network\.update: flow length 3 !== nodeCount 4/);
  });

  it("new modules without module links clear the held ones: they are addressed in the old modules' paths", () => {
    const plan = planNetworkUpdate("t", 4, { modules: PAIRS }, held());
    expect(plan.hierarchy?.modules).toBe(PAIRS);
    expect(plan.hierarchy?.moduleLinks).toBeUndefined();
    expect(Array.from(plan.hierarchy?.recordOf ?? [])).toEqual([0, 1, 2, 3]);
    // A held link to the leaf 1:2 is no endpoint of a hierarchy of four singletons, and is not checked against it.
    const leafLinked = planNetworkUpdate("t", 4, { modules: MODULES, moduleLinks: [{ source: [1, 2], target: [2], flow: 1 }] }, null).hierarchy ?? fail();
    const singletons: ModuleNode[] = [0, 1, 2, 3].map((id) => ({ id, path: [id + 1, 1] }));
    expect(planNetworkUpdate("t", 4, { modules: singletons }, leafLinked).hierarchy?.moduleLinks).toBeUndefined();
    // New links with new modules are checked against the new modules.
    expect(() => planNetworkUpdate("t", 4, { modules: singletons, moduleLinks: leafLinked.moduleLinks }, leafLinked)).toThrow(/endpoint 1:2/);
  });

  it("new module links on the held modules", () => {
    const h = held();
    const links: ModuleLink[] = [{ source: [2], target: [1], flow: 0.1 }];
    const plan = planNetworkUpdate("t", 4, { moduleLinks: links }, h);
    expect(plan.hierarchy?.modules).toBe(MODULES);
    expect(plan.hierarchy?.moduleLinks).toBe(links);
    expect(plan.hierarchy?.recordOf).toBe(h.recordOf); // the held records were checked already
    expect(planNetworkUpdate("t", 4, { moduleLinks: null }, h).hierarchy?.moduleLinks).toBeUndefined();
  });

  it("modules: null removes the modules and their links", () => {
    expect(planNetworkUpdate("t", 4, { modules: null }, held())).toEqual({ flow: undefined, hierarchy: null });
    expect(planNetworkUpdate("t", 4, { modules: null, moduleLinks: null }, held()).hierarchy).toBeNull();
  });

  it("module links need modules, given or held", () => {
    expect(() => planNetworkUpdate("network.update", 4, { moduleLinks: LINKS }, null)).toThrow(/network\.update: moduleLinks requires modules/);
    expect(() => planNetworkUpdate("t", 4, { modules: null, moduleLinks: LINKS }, held())).toThrow(/requires modules/);
    expect(() => planNetworkUpdate("t", 4, { moduleLinks: [] }, null)).toThrow(/requires modules/);
  });

  it("runs the checks data() runs: every node once, every module link endpoint in the hierarchy", () => {
    expect(() => planNetworkUpdate("t", 4, { modules: MODULES.slice(1) }, null)).toThrow(/no record for node id 0/);
    expect(() => planNetworkUpdate("t", 4, { modules: [...MODULES, { id: 3, path: [3, 1] }] }, null)).toThrow(/duplicate record/);
    expect(() => planNetworkUpdate("t", 4, { modules: MODULES, moduleLinks: [{ source: [99], target: [1], flow: 1 }] }, null)).toThrow(/module link endpoint 99/);
  });
});
