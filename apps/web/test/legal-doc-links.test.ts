/**
 * Every link between legal documents must land on the document it names.
 *
 * The renderer used to derive the route from the file name by lowercasing it and
 * swapping underscores for hyphens, which produced `#/legal/privacy-policy` for
 * `PRIVACY_POLICY.md`. The app serves that document at `#/legal/privacy`, so
 * nine of the ten cross-document links in `docs/legal/` landed on the "choose a
 * document" index instead: the Organiser Terms' pointer to the Privacy Policy,
 * the DPA's pointer to both, and the rest. Only `ORGANISER_TERMS.md` happened to
 * derive correctly, which is why it survived review.
 *
 * Those hrefs were also fragment-only, so on the deployed app they resolved
 * against the injected `<base href>` and walked the reader onto the gateway
 * origin — the #605 class, in rendered markdown where the .svelte guard in
 * `no-base-relative-redirect.test.ts` cannot see them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderLegalMarkdown } from "../src/lib/legal/markdown.js";
import {
  LEGAL_DOCS,
  UNPUBLISHED_REFERENCES,
  fileFromRelativeLink,
  slugForFile,
} from "../src/lib/legal/docs.js";

const LEGAL_DIR = new URL("../../../docs/legal/", import.meta.url).pathname;

/** Only the documents the app actually serves; docs/legal holds others too. */
const SERVED_FILES = Object.values(LEGAL_DOCS).map((d) => d.file);

function read(file: string): string {
  return readFileSync(join(LEGAL_DIR, file), "utf-8");
}

/** `[label](target)` pairs that are not absolute URLs. */
function relativeLinks(md: string): { label: string; href: string }[] {
  return [...md.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]
    .map((m) => ({ label: m[1], href: m[2] }))
    .filter((l) => !/^https?:\/\//.test(l.href));
}

test("every document the app serves is present on disk", () => {
  const onDisk = new Set(readdirSync(LEGAL_DIR));
  for (const file of SERVED_FILES) {
    assert.ok(onDisk.has(file), `${file} is served by a route but missing from docs/legal/`);
  }
});

test("every cross-document link resolves to a document the app serves", () => {
  const unresolved: string[] = [];
  for (const file of SERVED_FILES) {
    for (const link of relativeLinks(read(file))) {
      const target = fileFromRelativeLink(link.href);
      // The slug must be a route the app actually serves, not merely a string:
      // the rule this replaced returned a plausible-looking slug for everything.
      const slug = slugForFile(target);
      if (slug && LEGAL_DOCS[slug]?.file.toLowerCase() === target.toLowerCase()) continue;
      // A known gap, recorded rather than derived: see UNPUBLISHED_REFERENCES.
      if (UNPUBLISHED_REFERENCES.includes(target)) continue;
      unresolved.push(`${file}: [${link.label}](${link.href})`);
    }
  }
  assert.deepEqual(
    unresolved,
    [],
    "add the document to LEGAL_DOCS, fix the link, or record it in UNPUBLISHED_REFERENCES",
  );
});

test("a resolvable link renders as an absolute href, never a bare fragment", () => {
  const resolve = (href: string) => {
    const slug = slugForFile(href);
    return slug ? `https://woco.eth.limo/#/legal/${slug}` : null;
  };
  for (const file of SERVED_FILES) {
    const html = renderLegalMarkdown(read(file), resolve);
    assert.ok(
      !/href="#/.test(html),
      `${file} rendered a fragment-only href, which resolves against the deploy's <base href>`,
    );
  }
});

test("the Organiser Terms' pointer to the Privacy Policy is a working link", () => {
  const resolve = (href: string) => {
    const slug = slugForFile(href);
    return slug ? `https://woco.eth.limo/#/legal/${slug}` : null;
  };
  const html = renderLegalMarkdown(read("ORGANISER_TERMS.md"), resolve);
  assert.match(html, /href="https:\/\/woco\.eth\.limo\/#\/legal\/privacy"/);
  assert.doesNotMatch(html, /legal\/privacy-policy/, "the old derive-by-name rule is back");
});

test("a link the caller cannot resolve renders as text, not as a dead link", () => {
  const html = renderLegalMarkdown("See our [Security Posture](../SECURITY_POSTURE.md).", () => null);
  assert.match(html, /See our Security Posture\./);
  assert.doesNotMatch(html, /<a /);
});

test("external links keep their target and rel", () => {
  const html = renderLegalMarkdown("[ICO](https://ico.org.uk/make-a-complaint/)", () => null);
  assert.match(html, /<a href="https:\/\/ico\.org\.uk\/make-a-complaint\/" target="_blank" rel="noopener noreferrer">ICO<\/a>/);
});
