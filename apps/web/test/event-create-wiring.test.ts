/**
 * Every screen that creates an event hands EVERY field the editor collects to the
 * publish button. The live create route (/create redirects to /site-builder) bound
 * neither `geo` nor `tags`, so a picked place and chosen genres were dropped before
 * the request: every stored feed lacked coordinates and "near me" hid every event.
 * By SOURCE SCAN - the components declare `$state`, which Node cannot load.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = new URL("../src/", import.meta.url).pathname;
const read = (p: string) => readFileSync(SRC + p, "utf-8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** Names declared in a component's `let { ... }: Props = $props()` destructure. */
function propNames(src: string, bindableOnly: boolean): Set<string> {
  const m = /let \{([\s\S]*?)\}: Props = \$props\(\);/.exec(src);
  assert.ok(m, "the component must destructure its props - a rename would make this pass vacuously");
  const names = new Set<string>();
  for (const part of m[1]!.split(",")) {
    const name = /^\s*([A-Za-z_$][\w$]*)/.exec(part)?.[1];
    if (!name) continue;
    if (!bindableOnly || /\$bindable\(/.test(part)) names.add(name);
  }
  return names;
}

/** The attribute text of the first `<Tag ... />` in `src`. */
function tagAttrs(src: string, tag: string): string {
  const start = src.indexOf(`<${tag}`);
  assert.ok(start >= 0, `<${tag}> must be rendered`);
  const end = src.indexOf("/>", start);
  assert.ok(end > start, `<${tag}> must close`);
  return src.slice(start + tag.length + 1, end);
}

/** The variable a parent binds to the editor's `prop`: `bind:prop={v}` -> v, `bind:prop` -> prop. */
function boundVar(attrs: string, prop: string): string | null {
  const m = new RegExp(`bind:${prop}(?:=\\{\\s*([\\w$]+)\\s*\\})?(?=[\\s/]|$)`).exec(attrs);
  return m ? (m[1] ?? prop) : null;
}

/** The expression a parent passes as the button's `prop`: `prop={expr}` or the `{prop}` shorthand. */
function passedExpr(attrs: string, prop: string): string | null {
  const long = new RegExp(`(?:^|\\s)${prop}=\\{([^}]*)\\}`).exec(attrs);
  if (long) return long[1]!;
  return new RegExp(`(?:^|\\s)\\{${prop}\\}`).test(attrs) ? prop : null;
}

const EDITOR = code(read("lib/creator/events/EventEditor.svelte"));
const BUTTON = code(read("lib/creator/events/PublishButton.svelte"));
const editorFields = propNames(EDITOR, true);
const buttonProps = propNames(BUTTON, false);
const shared = [...editorFields].filter((p) => buttonProps.has(p));

test("the editor collects a place and genres, and the publish button sends them", () => {
  for (const p of ["geo", "tags", "location", "title"]) {
    assert.ok(shared.includes(p), `${p} must be an editor field the publish button accepts`);
  }
});

const CREATORS = ["lib/creator/SiteBuilder.svelte", "lib/creator/events/EventForm.svelte"];

for (const file of CREATORS) {
  test(`${file}: every editor field reaches the publish button through the same variable`, () => {
    const src = code(read(file));
    const editor = tagAttrs(src, "EventEditor");
    const button = tagAttrs(src, "PublishButton");
    for (const prop of shared) {
      const v = boundVar(editor, prop);
      assert.ok(v, `${file}: <EventEditor> must bind:${prop} - unbound, the editor's value never leaves it`);
      const expr = passedExpr(button, prop);
      assert.ok(expr, `${file}: <PublishButton> must be given ${prop}`);
      assert.match(expr, new RegExp(`\\b${v.replace(/\$/g, "\\$")}\\b`), `${file}: ${prop} must be the variable the editor writes (${v})`);
    }
  });
}
