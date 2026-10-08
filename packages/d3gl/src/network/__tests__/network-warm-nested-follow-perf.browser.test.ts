import { defineFollowGuard } from "./_follow-perf.js";

/** The followed warm nested stream's per-frame guard (#454); see `_follow-perf.ts`. */
defineFollowGuard("nested");
