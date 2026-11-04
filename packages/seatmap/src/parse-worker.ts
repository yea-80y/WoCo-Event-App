/// <reference lib="webworker" />
// Parses a big seating plan off the page's thread (parse.ts decides when).
import { parseSeatPlan } from "@woco/shared/seating/plan";

self.onmessage = (e: MessageEvent<{ bytes: ArrayBuffer; digest: string }>) => {
  let plan = null;
  try {
    plan = parseSeatPlan(new Uint8Array(e.data.bytes), e.data.digest);
  } catch {
    plan = null;
  }
  (self as unknown as Worker).postMessage(plan);
};
