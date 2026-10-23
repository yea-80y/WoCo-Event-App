/**
 * One server log line each time a health check turns red, and one when it turns
 * green again.
 *
 * The uptime monitor sees only a 503 from `/api/health/alarms`, and the report
 * behind it is rebuilt on every request, so once an alarm cleared nothing said
 * which check it had been (2026-10-22: a 10-minute page no log could name). The
 * server's lines reach the VM journal, which outlives every deploy, so a page
 * can now be read back by its time.
 *
 * Leaf paths only: `postage` and `postage.bee` go red with the check under them,
 * and three lines for one cause would bury the one that names it. `ok: null`
 * (a probe that could not read) is not logged, for the reason alarm-gate.ts
 * never pages on it: it would fire at every RPC blip.
 */

import { alarmGate } from "./alarm-gate.js";

/** The red paths of a full report that have no red path beneath them. */
export function redLeaves(report: Record<string, unknown>): string[] {
  const { body } = alarmGate(report, undefined);
  const red = "red" in body ? body.red : [];
  return red.filter((path) => !red.some((other) => other.startsWith(`${path}.`)));
}

/**
 * A watcher fed the report once a minute. Its first call logs what is already
 * red, so a journal read after a restart has a starting point.
 */
export function createAlarmLog(log: (line: string) => void = (line) => console.warn(line)) {
  let redSince: Map<string, number> | null = null;
  return (report: Record<string, unknown>, now = Date.now()): void => {
    const red = redLeaves(report);
    if (redSince === null) {
      redSince = new Map(red.map((path) => [path, now]));
      log(red.length ? `[alarm] red at start: ${red.join(", ")}` : "[alarm] all green at start");
      return;
    }
    for (const path of red) {
      if (redSince.has(path)) continue;
      redSince.set(path, now);
      log(`[alarm] RED ${path}`);
    }
    for (const [path, since] of redSince) {
      if (red.includes(path)) continue;
      redSince.delete(path);
      log(`[alarm] GREEN ${path} after ${Math.round((now - since) / 60_000)} min`);
    }
  };
}
