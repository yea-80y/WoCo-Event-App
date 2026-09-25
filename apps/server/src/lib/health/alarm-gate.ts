/**
 * `/api/health/alarms` (#672): the health report as one status code, for an
 * uptime monitor. `/api/health` always answers 200 with a top-level `ok: true`;
 * its alarms are per-section `ok: false` flags that only a reader sees, so no
 * monitor can page on it and every alarm on it reached nobody.
 *
 * 503 when any WATCHED section holds `ok: false` anywhere inside it, else 200.
 * `ok: null` (a probe that could not read) is listed but never pages: unknown
 * is its own answer (alarms.ts), and paging on it would cry wolf at every RPC
 * blip until the monitor was switched off.
 *
 * `?sections=a,b.c` picks what to watch, in the monitor's own URL. A known and
 * accepted red (a batch the owner tops up by hand) is left out there rather
 * than by a server-side mute list that could outlive its reason. A name that
 * does not resolve is a 400, never an empty watch that reads green for ever.
 * Paths only in the response, like the report itself: the endpoint is public.
 */

export interface AlarmGateResult {
  status: 200 | 400 | 503;
  body:
    | { ok: boolean; watched: string[] | "all"; red: string[]; unknown: string[] }
    | { ok: false; error: string };
}

const SEGMENT = /^[A-Za-z0-9_]{1,64}$/;
const MAX_SECTIONS = 50;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function walk(v: unknown, path: string, red: string[], unknown: string[]): void {
  if (Array.isArray(v)) {
    v.forEach((item, i) => walk(item, `${path}.${i}`, red, unknown));
    return;
  }
  if (!isObject(v)) return;
  if (v.ok === false) red.push(path);
  if (v.ok === null) unknown.push(path);
  for (const [k, child] of Object.entries(v)) walk(child, `${path}.${k}`, red, unknown);
}

function resolve(report: Record<string, unknown>, path: string): unknown {
  let node: unknown = report;
  for (const seg of path.split(".")) {
    if (!isObject(node) || !Object.hasOwn(node, seg)) return undefined;
    node = node[seg];
  }
  return node;
}

export function alarmGate(report: Record<string, unknown>, sectionsParam: string | undefined): AlarmGateResult {
  const red: string[] = [];
  const unknown: string[] = [];
  const requested = (sectionsParam ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  if (requested.length === 0) {
    // Children only: the report's own top-level `ok` is a constant, not a verdict.
    for (const [k, v] of Object.entries(report)) walk(v, k, red, unknown);
    return { status: red.length ? 503 : 200, body: { ok: red.length === 0, watched: "all", red, unknown } };
  }

  if (requested.length > MAX_SECTIONS) {
    return { status: 400, body: { ok: false, error: `at most ${MAX_SECTIONS} sections` } };
  }
  for (const path of requested) {
    if (!path.split(".").every((seg) => SEGMENT.test(seg))) {
      return { status: 400, body: { ok: false, error: "section names are letters, digits and _, joined by ." } };
    }
    const node = resolve(report, path);
    if (!isObject(node) && !Array.isArray(node)) {
      return { status: 400, body: { ok: false, error: `no such section: ${path}` } };
    }
    walk(node, path, red, unknown);
  }
  // Overlapping picks (`subEns,subEns.minting`) walk the same node twice.
  const r = [...new Set(red)];
  const u = [...new Set(unknown)];
  return { status: r.length ? 503 : 200, body: { ok: r.length === 0, watched: requested, red: r, unknown: u } };
}
