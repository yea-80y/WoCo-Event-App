import type { IndexHtmlTransformContext, Plugin } from "vite";
import type { OutputChunk } from "rollup";

/**
 * The app entry is src/boot.ts, which imports src/main.ts dynamically once it knows
 * this build is the one to run. Vite only preloads an entry's STATIC imports, so
 * without this the app's chunks would start downloading only after the check -
 * one round trip later than before boot.ts existed. These hints fetch them in
 * parallel without evaluating them, which is the point: a page that hands over to
 * a newer build must never run this build's app modules. The style preload is
 * crossorigin because Vite's preload helper inserts the stylesheet that way; a
 * mismatch makes the browser fetch the CSS twice.
 */
export function preloadApp(): Plugin {
  return {
    name: "woco:preload-app",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html: string, ctx: IndexHtmlTransformContext) {
        if ((ctx.filename.split("/").pop() ?? "") !== "index.html" || !ctx.bundle) return;
        const chunks = Object.values(ctx.bundle).filter((c): c is OutputChunk => c.type === "chunk");
        // A dynamic entry has no facade id; find it by the module it carries.
        const main = chunks.find((c) => c.isDynamicEntry && c.moduleIds.some((m) => m.endsWith("/src/main.ts")));
        if (!main) throw new Error("preload-app: no dynamic chunk for src/main.ts - did the entry change?");
        const byName = new Map(chunks.map((c) => [c.fileName, c]));
        const js = new Set<string>();
        const css = new Set<string>();
        const visit = (c: OutputChunk) => {
          if (js.has(c.fileName)) return;
          js.add(c.fileName);
          for (const f of (c as OutputChunk & { viteMetadata?: { importedCss: Set<string> } }).viteMetadata?.importedCss ?? []) css.add(f);
          for (const dep of c.imports) {
            const d = byName.get(dep);
            if (d) visit(d);
          }
        };
        visit(main);
        // Vite already hints boot.ts's own imports; do not list those twice.
        const hinted = (f: string) => html.includes(`"./${f}"`);
        return [
          ...[...css].filter((f) => !hinted(f)).map((f) => ({ tag: "link", attrs: { rel: "preload", as: "style", crossorigin: true, href: `./${f}` }, injectTo: "head" as const })),
          ...[...js].filter((f) => !hinted(f)).map((f) => ({ tag: "link", attrs: { rel: "modulepreload", crossorigin: true, href: `./${f}` }, injectTo: "head" as const })),
        ];
      },
    },
  };
}
