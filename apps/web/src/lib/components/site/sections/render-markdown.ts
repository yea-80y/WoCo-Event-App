/**
 * Markdown rendering for RichTextSection (#212).
 *
 * ---------------------------------------------------------------------------
 * INVARIANT — read this before changing anything in this file.
 * ---------------------------------------------------------------------------
 *
 * The return value of `renderMarkdown` is handed to Svelte's `{@html}`, so it
 * is parsed as markup, and the input is written by one party (the organiser)
 * and read by another (their visitors).
 *
 * State the guarantee without reference to where the page is hosted. WoCo sites
 * have been served from the WoCo gateway, are moving to the Etherna gateway
 * where every site shares one origin with every other, and will mostly be
 * reached on an organiser's own domain or sub-ENS name. The guarantee has to
 * hold in all of them, so do NOT re-derive it from whichever origin happens to
 * be current — that reasoning invites "we aren't same-origin with the app any
 * more, so we can relax this", which does not follow.
 *
 * Safety rests on exactly two properties, and on nothing else:
 *
 *   1. The input is escaped FIRST, before any substitution runs. Afterwards
 *      the only `<` characters in the string are ones this function itself
 *      wrote, so no organiser byte can be parsed as markup.
 *
 *   2. Every tag this function emits is a fixed literal carrying NO attributes.
 *      That is the only reason escaping `& < >` is sufficient: `"` and `'` are
 *      significant solely inside attribute values, and this pipeline builds
 *      none.
 *
 * Both properties break the moment a tag with an attribute is added — a link,
 * an image, a class, an id. Quote escaping becomes mandatory AND a URL scheme
 * (`javascript:`, `data:`) becomes reachable. Adding links or images here
 * requires replacing this with a real allowlist sanitiser; it is not a matter
 * of extending the substitution list.
 */

/**
 * Escape the three characters that are significant in HTML element text.
 *
 * The `&`-first ordering is load-bearing, not stylistic. Escaping `<` first
 * would produce `&lt;`, and a subsequent `&` pass would then corrupt it into
 * `&amp;lt;`.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Render a very small markdown subset: `#`/`##`/`###` headings, `**bold**`,
 * `*italic*`, blank-line-separated paragraphs and single-newline line breaks.
 *
 * Deliberately supports no links and no images — see the invariant above.
 */
export function renderMarkdown(md: string): string {
  return escapeHtml(md ?? "")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    // Only this function's own headings can start a block with `<h` now: an
    // organiser's literal "<h..." has already become "&lt;h...". Before the
    // escape step this branch was reachable with raw input.
    .map((p) => (p.startsWith("<h") ? p : `<p>${p.replace(/\n/g, "<br>")}</p>`))
    .join("\n");
}
