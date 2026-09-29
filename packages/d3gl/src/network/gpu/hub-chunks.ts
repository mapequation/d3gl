/**
 * Chunked CSR spring rows (#350, spec `2026-09-26-gpu-segmented-solver-design.md` §6.3) — the pure,
 * node-testable CPU half.
 *
 * The GPU spring pass gathers one node's row per fragment. A row longer than {@link SPRING_CHUNK}
 * entries (a *hub*) would make that one fragment loop over its whole degree — up to 10,721 times on
 * web-NotreDame — so the pass used to cap the loop at 4096 and silently drop the rest (13,507
 * half-edges on 5 hubs), which broke action-reaction. Instead a hub row is split into chunks of at
 * most {@link HUB_CHUNK} entries: a separate pass sums each chunk into a partial, and the hub's own row
 * fragment adds its partials. Every CSR entry is then gathered exactly once and no fragment loops
 * more than `SPRING_CHUNK` times (up to degree `SPRING_CHUNK · HUB_CHUNK`).
 */

/**
 * The most CSR entries one fragment gathers directly (the spec's C). Rows at or below it keep the
 * one-fragment row gather, bit for bit; longer rows (*hubs*) are chunked. 256 leaves all but 1,705 of
 * web-NotreDame's 325,729 rows on the row gather; the hubs hold 23% of its 3.0M entries.
 */
export const SPRING_CHUNK = 256;

/**
 * The most CSR entries in one hub chunk — finer than {@link SPRING_CHUNK} on purpose. The chunk pass
 * has only K fragments (11,385 on web-NotreDame), far too few to fill a GPU, so its time is one
 * fragment's serial loop and grows with the chunk length, not with K. Measured on web-NotreDame (Apple
 * M1 Max, ANGLE Metal), the pass adds 0.70 ms to a tick at 256 entries per chunk, 0.34 ms at 128,
 * 0.28 ms at 64 and 0.15 ms at 32. At 64 a hub's partial loop stays within `SPRING_CHUNK` up to degree
 * 16,384, and the chunk textures take 24 bytes per chunk (0.27 MB on web-NotreDame).
 */
export const HUB_CHUNK = 64;

/**
 * The hub chunk table: one entry per chunk of at most {@link HUB_CHUNK} entries, of every row longer than
 * {@link SPRING_CHUNK}.
 */
export interface HubChunks {
  /** Number of chunks K (0 when no row is longer than the chunk size). */
  readonly count: number;
  /**
   * `K × 4` uint32, one `rgba32ui` texel per chunk: `(row, entry start, entry end, 0)`, with `[start,
   * end)` a range of CSR entries of that row. Chunks are in CSR order, so entry starts ascend strictly,
   * and chunk `k` of a row starts at the row's offset `+ k · HUB_CHUNK`: the force pass finds a hub
   * row's first chunk by binary search on the start and reads `ceil(degree / HUB_CHUNK)` partials from
   * there.
   */
  readonly table: Uint32Array;
}

/**
 * Split every CSR row longer than {@link SPRING_CHUNK} entries into consecutive chunks of at most
 * {@link HUB_CHUNK} entries. O(rows + chunks) time, `16 · chunks` bytes.
 *
 * @param offsets CSR row offsets, length `rows + 1` (as {@link buildCSR} returns them).
 */
export function buildHubChunks(offsets: Uint32Array): HubChunks {
  const rows = Math.max(0, offsets.length - 1);
  let count = 0;
  for (let i = 0; i < rows; i++) {
    const degree = (offsets[i + 1] ?? 0) - (offsets[i] ?? 0);
    if (degree > SPRING_CHUNK) count += Math.ceil(degree / HUB_CHUNK);
  }
  const table = new Uint32Array(count * 4);
  let k = 0;
  for (let i = 0; i < rows; i++) {
    const start = offsets[i] ?? 0;
    const end = offsets[i + 1] ?? 0;
    if (end - start <= SPRING_CHUNK) continue;
    for (let s = start; s < end; s += HUB_CHUNK) {
      table[k * 4] = i;
      table[k * 4 + 1] = s;
      table[k * 4 + 2] = Math.min(end, s + HUB_CHUNK);
      k++;
    }
  }
  return { count, table };
}

/**
 * Whether a CSR with these row lengths has a row longer than {@link SPRING_CHUNK} — exactly when
 * {@link buildHubChunks} would return chunks for it (#385: the springs' program variant, known before the solver
 * builds its CSR). Pass the degrees the graph already holds (`NetworkGraph.csr.degree`, which `buildCSR` computed
 * from the same edges as the solver's). O(rows) reads, stopping at the first hub row; allocates nothing.
 */
export function hasHubRows(degree: ArrayLike<number>): boolean {
  for (let i = 0; i < degree.length; i++) {
    if ((degree[i] ?? 0) > SPRING_CHUNK) return true;
  }
  return false;
}
