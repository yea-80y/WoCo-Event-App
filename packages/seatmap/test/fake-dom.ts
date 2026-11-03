/**
 * The few DOM calls the renderer makes (createElementNS, attributes, children, text),
 * so its output can be inspected under `node --test` without a DOM dependency.
 */

export class FakeEl {
  readonly attrs = new Map<string, string>();
  readonly children: FakeEl[] = [];
  textContent = "";
  id = "";
  constructor(readonly tagName: string) {}
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
    if (k === "id") this.id = v;
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  appendChild<T extends FakeEl>(c: T): T {
    this.children.push(c);
    return c;
  }
  replaceChildren(): void {
    this.children.length = 0;
  }
  /** Every descendant, depth first. */
  *all(): Generator<FakeEl> {
    for (const c of this.children) {
      yield c;
      yield* c.all();
    }
  }
}

export function installFakeDom(): void {
  (globalThis as { document?: unknown }).document = {
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
  };
}

export function fakeSvg(id = "t"): FakeEl & SVGSVGElement {
  const s = new FakeEl("svg");
  s.setAttribute("id", id);
  return s as unknown as FakeEl & SVGSVGElement;
}
