/**
 * The legal documents the app serves, and the one mapping from a file name to
 * the route that serves it.
 *
 * Separate from `LegalPage.svelte` because three things need the same table and
 * drifted apart while it lived in the component: the page's own tabs, the
 * renderer that rewrites document-to-document links, and the test that checks
 * every such link lands somewhere. The slug is NOT derivable from the file name
 * — `PRIVACY_POLICY.md` is served at `/legal/privacy`, not `/legal/privacy-policy`
 * — which is exactly what the old derive-by-lowercasing rule got wrong.
 */

export interface LegalDoc {
  title: string;
  file: string;
}

/** Route slug → the document it serves. The slugs are public URLs: do not rename. */
export const LEGAL_DOCS: Record<string, LegalDoc> = {
  privacy: { title: "Privacy Policy", file: "PRIVACY_POLICY.md" },
  terms: { title: "Terms of Service", file: "TERMS_OF_SERVICE.md" },
  "organiser-terms": { title: "Organiser Terms", file: "ORGANISER_TERMS.md" },
  dpa: { title: "Data Processing Addendum", file: "DATA_PROCESSING_ADDENDUM.md" },
  cookies: { title: "Cookie Notice", file: "COOKIE_NOTICE.md" },
};

/**
 * Referenced by a legal document but NOT served by the app, so a link to it
 * renders as plain text rather than as a route that answers with the index.
 *
 * `SECURITY_POSTURE.md` is not in the repository at all (it was untracked by
 * `34b70fa1`), so the DPA's Annex 2 reference cannot resolve anywhere. Publishing
 * it, or dropping the reference, is a decision for whoever owns the DPA — until
 * then this list is where that gap is visible.
 */
export const UNPUBLISHED_REFERENCES: readonly string[] = ["SECURITY_POSTURE.md"];

/** The file a relative markdown link points at, with any `./` or `../` removed. */
export function fileFromRelativeLink(href: string): string {
  return href.replace(/^(?:\.\.?\/)+/, "").trim();
}

/** The route slug that serves `file`, or null when the app does not serve it. */
export function slugForFile(file: string): string | null {
  const name = fileFromRelativeLink(file);
  const hit = Object.entries(LEGAL_DOCS).find(([, d]) => d.file.toLowerCase() === name.toLowerCase());
  return hit ? hit[0] : null;
}
