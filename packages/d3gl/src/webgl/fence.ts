/**
 * Non-blocking WebGL2 fences, shared by the PBO readbacks: the pick readback (#141) and the GPU
 * layout's streaming readback and frame budget (#352).
 *
 * A poll is `clientWaitSync(sync, SYNC_FLUSH_COMMANDS_BIT, 0)`: timeout 0 never blocks, and the flush
 * bit guarantees the fence reaches the GPU — without it a fence can stay unsignalled forever when its
 * commands were never flushed (observed under headless software-GL contention, #141). Sync status only
 * changes between tasks, so a fence is never seen signalled in the task that inserted it.
 */

/** What a non-blocking poll found. `"lost"`: the wait failed (a lost context), so it never will signal. */
export type SyncStatus = "signaled" | "pending" | "lost";

/** Poll `sync` without blocking. A `null` sync (what `fenceSync` returns on a lost context) is `"lost"`. */
export function pollSync(gl: WebGL2RenderingContext, sync: WebGLSync | null): SyncStatus {
  if (sync === null) return "lost";
  const status = gl.clientWaitSync(sync, gl.SYNC_FLUSH_COMMANDS_BIT, 0);
  if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) return "signaled";
  return status === gl.WAIT_FAILED ? "lost" : "pending";
}

/**
 * Insert a fence after every command issued so far and flush, so the fence (and a readback copied
 * before it) is submitted and can complete by the next frame. `null` on a lost context.
 */
export function insertSync(gl: WebGL2RenderingContext): WebGLSync | null {
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  return sync;
}

/** Delete `sync` (a no-op for `null`). */
export function deleteSync(gl: WebGL2RenderingContext, sync: WebGLSync | null): void {
  if (sync !== null) gl.deleteSync(sync);
}
