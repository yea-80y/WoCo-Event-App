/**
 * Minimal markdown → HTML for the legal pages.
 *
 * Deliberately not a dependency: these documents are ours, their markdown
 * subset is known and fixed, and the legal routes are lazy-loaded — pulling a
 * full parser in would cost more bundle than the pages themselves.
 *
 * Supports exactly what docs/legal/*.md use: headings, bold, italic, links,
 * inline code, unordered/ordered lists, tables, blockquotes and rules.
 *
 * Input is our own committed markdown, never user content — so this is not a
 * sanitiser and must not be pointed at anything a user can write.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Inline spans, applied after block structure is resolved. */
function inline(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    // Links last: the label may already contain the spans above.
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_m, label: string, href: string) => {
        const external = /^https?:\/\//.test(href);
        // Relative .md links point at sibling documents — map them onto the
        // hash routes the app actually serves.
        const to = external
          ? href
          : `#/legal/${href.replace(/^\.\//, "").replace(/\.md$/, "").toLowerCase().replace(/_/g, "-")}`;
        const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
        return `<a href="${to}"${attrs}>${label}</a>`;
      },
    );
}

function renderTable(rows: string[]): string {
  const cells = (line: string) =>
    line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const [head, , ...body] = rows;
  const th = cells(head).map((c) => `<th>${inline(c)}</th>`).join("");
  const trs = body
    .map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

export function renderLegalMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) { out.push("<hr />"); i++; continue; }

    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Table — a header row followed by a separator row
    if (line.trim().startsWith("|") && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(lines[i++].trim());
      out.push(renderTable(rows));
      continue;
    }

    // Blockquote (callouts — the PRE-LAUNCH DRAFT banners rely on this)
    if (line.trimStart().startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith(">")) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${inline(buf.join(" ")).replace(/\n/g, "<br />")}</blockquote>`);
      continue;
    }

    // Lists
    const ul = /^\s*[-*]\s+/;
    const ol = /^\s*\d+\.\s+/;
    if (ul.test(line) || ol.test(line)) {
      const ordered = ol.test(line);
      const re = ordered ? ol : ul;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i])) {
        let item = lines[i].replace(re, "");
        i++;
        // Continuation lines are indented under the bullet.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !re.test(lines[i])) {
          item += " " + lines[i].trim();
          i++;
        }
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }

    // Paragraph — consume until a blank line or the start of another block
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|---+$|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i]) &&
      !lines[i].trimStart().startsWith(">") &&
      !lines[i].trim().startsWith("|")
    ) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
  }

  return out.join("\n");
}
