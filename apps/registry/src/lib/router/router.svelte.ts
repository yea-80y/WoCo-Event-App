/**
 * Simple hash-based router for the World Computer Registry.
 * Routes: #/ (verify), #/register, #/browse, #/my
 */

let _route = $state("verify");
let _params = $state<Record<string, string>>({});

function parseHash(): string {
  const hash = typeof window !== "undefined" ? window.location.hash : "";
  return hash.replace(/^#/, "") || "/";
}

function matchRoute(path: string): { route: string; params: Record<string, string> } {
  if (path === "/" || path === "" || path === "/verify") return { route: "verify", params: {} };
  if (path === "/register") return { route: "register", params: {} };
  if (path === "/browse") return { route: "browse", params: {} };
  if (path === "/my") return { route: "my", params: {} };
  return { route: "verify", params: {} };
}

function update() {
  const path = parseHash();
  const matched = matchRoute(path);
  _route = matched.route;
  _params = matched.params;
}

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", update);
  update();
}

export function navigate(path: string) {
  window.location.hash = path;
}

export const router = {
  get route() { return _route; },
  get params() { return _params; },
  navigate,
};
