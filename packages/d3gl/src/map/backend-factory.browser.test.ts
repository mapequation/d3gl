import { describe, it, expect } from "vitest";
import { createBackend } from "./backend-factory.js";

describe("createBackend", () => {
  it("creates a working backend + element for each type", async () => {
    for (const type of ["canvas", "svg", "webgl"] as const) {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const { backend, element } = await createBackend(type, host, 64, 64);
      expect(backend).toBeTruthy();
      expect(element).toBeTruthy();
      backend.destroy();
      host.remove();
    }
  });
});
