/**
 * Simple hash-based router using Svelte 5 runes.
 * Routes: #/ (home), #/create (new event), #/event/:id (detail)
 */

let _path = $state(parseHash());
let _params = $state<Record<string, string>>({});

function parseHash(): string {
  const hash = typeof window !== "undefined" ? window.location.hash : "";
  return hash.replace(/^#/, "") || "/";
}

function matchRoute(path: string): { route: string; params: Record<string, string> } {
  if (path === "/" || path === "") return { route: "home", params: {} };
  if (path === "/create") return { route: "create", params: {} };

  const eventMatch = path.match(/^\/event\/(.+)$/);
  if (eventMatch) return { route: "event", params: { id: eventMatch[1] } };

  return { route: "home", params: {} };
}

function update() {
  _path = parseHash();
  const matched = matchRoute(_path);
  _params = matched.params;
  _path = matched.route;
}

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", update);
  update();
}

export function navigate(path: string) {
  window.location.hash = path;
}

export const router = {
  get route() { return _path; },
  get params() { return _params; },
  navigate,
};
