/**
 * Bundle parsing and its content-address check, off the page's thread (#1061 fix 3).
 *
 * At 20k orders the check (`parseBundle` -> `boxFromBytes` -> keccak, ~1 ms per box)
 * was 58% of the page's busy time. It runs unchanged in a KEY-FREE worker
 * (`bundle-verify.worker.ts`), never in the opener workers: parsing raw gateway bytes
 * stays outside the code that holds the order keys (Fable consult 2026-11-03 Q3).
 *
 * What the page trusts is "the worker ran our code" (same origin, same build, a port
 * no other context can write to). What it checks is that a reply answers ITS request:
 * - the id is one it is waiting on, once;
 * - one result per root, matched BY POSITION to the roots the page kept, keyed by the
 *   page's own strings;
 * - only the kinds a bundle can produce (never "limited", which would pause the queue);
 * - every "ok" box passes `isSealedBoxV2`.
 * Anything else, and any trouble at all (cannot start, error, timeout), and the page
 * parses that bundle itself from the copy it kept - the body is CLONED to the worker,
 * never transferred - and every later one too. `parse` never rejects and never
 * answers null for its own trouble: null is only `parseBundle`'s verdict, and a failure
 * here must not count against the gateway (gateway-fetcher.ts give-up rule).
 */
import { isSealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import type { FetchResult } from "./detail-queue.js";
import { parseBundle } from "./order-box.js";

export interface VerifyRequest {
  id: number;
  roots: string[];
  body: Uint8Array;
}

/** `results`: one per root, in request order; null = the body is not an answer to the roots. */
export interface VerifyReply {
  id: number;
  results: FetchResult[] | null;
}

/** What the page needs of a Worker. */
export interface VerifierPort {
  postMessage(msg: VerifyRequest): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessageerror: ((e: unknown) => void) | null;
  terminate(): void;
}

/**
 * Generous on purpose: the worker holds at most the queue's bundles in flight (~100 ms
 * of hashing each), and giving up is permanent for the page.
 */
export const VERIFY_TIMEOUT_MS = 45_000;

/** The worker's whole job, kept here so it is tested directly. Null = not a request. */
export function answerVerifyRequest(req: unknown): VerifyReply | null {
  const r = req as Partial<VerifyRequest> | null;
  if (!r || typeof r.id !== "number" || !Array.isArray(r.roots) || !r.roots.every((x) => typeof x === "string")) return null;
  if (!(r.body instanceof Uint8Array)) return null;
  const items = parseBundle(r.roots, r.body);
  return { id: r.id, results: items ? r.roots.map((root) => items.get(root)!) : null };
}

const BUNDLE_KINDS = new Set(["ok", "missing", "unavailable", "unreadable"]);

/**
 * A worker's results as the page's own map, or undefined when they are not a
 * well-formed answer to `roots` (the worker is then not trusted again).
 */
export function resultsFromReply(roots: readonly string[], results: unknown): Map<string, FetchResult> | null | undefined {
  if (results === null) return null;
  if (!Array.isArray(results) || results.length !== roots.length) return undefined;
  const out = new Map<string, FetchResult>();
  for (let i = 0; i < roots.length; i++) {
    const r = results[i] as { kind?: unknown; box?: unknown } | null;
    if (typeof r !== "object" || r === null || typeof r.kind !== "string" || !BUNDLE_KINDS.has(r.kind)) return undefined;
    if (r.kind === "ok") {
      if (!isSealedBoxV2(r.box)) return undefined;
      out.set(roots[i], { kind: "ok", box: r.box });
    } else {
      out.set(roots[i], { kind: r.kind as "missing" | "unavailable" | "unreadable" });
    }
  }
  return out;
}

interface Waiting {
  roots: string[];
  body: Uint8Array;
  resolve(r: Map<string, FetchResult> | null): void;
}

export class BundleVerifier {
  private port: VerifierPort | null = null;
  private broken = false;
  private nextId = 0;
  private readonly waiting = new Map<number, Waiting>();

  constructor(
    private readonly spawn: () => VerifierPort,
    private readonly timeoutMs: number = VERIFY_TIMEOUT_MS,
    private readonly onPage: (roots: readonly string[], body: Uint8Array) => Map<string, FetchResult> | null = parseBundle,
  ) {}

  /** `parseBundle(roots, body)`, from the worker when it can, else on the page. Never rejects. */
  parse(roots: readonly string[], body: Uint8Array): Promise<Map<string, FetchResult> | null> {
    if (this.broken || !this.started()) return Promise.resolve(this.onPage(roots, body));
    const id = ++this.nextId;
    const own = [...roots];
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiting.has(id)) this.fail();
      }, this.timeoutMs);
      this.waiting.set(id, {
        roots: own,
        body,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      });
      try {
        // Cloned, not transferred: the page keeps its bytes for the fallback.
        this.port!.postMessage({ id, roots: own, body });
      } catch {
        this.fail();
      }
    });
  }

  /** The page is gone: end the worker. Anything still waiting is parsed on the page. */
  dispose(): void {
    this.fail();
  }

  private started(): boolean {
    if (this.port) return true;
    try {
      const port = this.spawn();
      port.onmessage = (e) => this.reply(e.data);
      port.onerror = () => this.fail();
      port.onmessageerror = () => this.fail();
      this.port = port;
      return true;
    } catch {
      this.broken = true;
      return false;
    }
  }

  private reply(data: unknown): void {
    const msg = data as { id?: unknown; results?: unknown } | null;
    const w = msg && typeof msg.id === "number" ? this.waiting.get(msg.id) : undefined;
    // An id it is not waiting on - unknown, or answered already: stop trusting the worker.
    if (!w || typeof msg?.id !== "number") {
      this.fail();
      return;
    }
    this.waiting.delete(msg.id);
    const out = resultsFromReply(w.roots, msg.results);
    if (out === undefined) {
      w.resolve(this.onPage(w.roots, w.body));
      this.fail();
      return;
    }
    w.resolve(out);
  }

  private fail(): void {
    this.broken = true;
    if (this.port) {
      this.port.onmessage = null;
      this.port.onerror = null;
      this.port.onmessageerror = null;
      this.port.terminate();
      this.port = null;
    }
    const all = [...this.waiting.values()];
    this.waiting.clear();
    for (const w of all) w.resolve(this.onPage(w.roots, w.body));
  }
}
