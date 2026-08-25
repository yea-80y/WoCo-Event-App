/**
 * Which commit is this process running?
 *
 * The deploy rsyncs a working directory and builds the image ON the VM, so
 * neither the container nor the host has a `.git` to ask — the answer has to
 * travel with the bytes. `scripts/deploy-server.sh` writes `.deploy-commit`
 * from the SHA it has just verified, immediately before the rsync, and the
 * Dockerfile copies it in. Read once at boot: the file cannot change under a
 * running container, and re-reading it per request would only add a syscall to
 * a public endpoint.
 *
 * Absent means nobody stamped this build — a plain `docker compose build`, or a
 * deploy that bypassed the script. It reports `unknown`, which is the honest
 * answer; the failure to avoid is a stale stamp read as current, which is why
 * the script rewrites the file on EVERY run including `--allow-dirty`.
 *
 * A `-dirty` suffix means the tree carried uncommitted changes, so the commit
 * names roughly what shipped and not exactly what shipped. That distinction is
 * the whole point of reporting it: "production is running 09e24b3" is a claim
 * worth being able to check, and a half-truth is worse than no claim.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface BuildInfo {
  /** Full SHA, optionally suffixed `-dirty`; `"unknown"` if unstamped. */
  commit: string;
  /** False when the deploying tree had uncommitted changes. */
  clean: boolean;
  /** When the stamp was written (UTC ISO), if known. */
  stampedAt?: string;
}

function read(): BuildInfo {
  try {
    const [commit = "", stampedAt] = readFileSync(join(process.cwd(), ".deploy-commit"), "utf-8")
      .split("\n")
      .map((l) => l.trim());
    if (!commit) return { commit: "unknown", clean: false };
    return {
      commit,
      clean: !commit.endsWith("-dirty"),
      ...(stampedAt ? { stampedAt } : {}),
    };
  } catch {
    // Unstamped is not an error condition — local dev has no stamp and should
    // not log a scary line every boot.
    return { commit: "unknown", clean: false };
  }
}

const INFO: BuildInfo = read();

export function buildInfo(): BuildInfo {
  return INFO;
}
