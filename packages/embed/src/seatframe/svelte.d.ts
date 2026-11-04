// tsc reads .svelte imports through this; svelte-check checks the components themselves.
declare module "*.svelte" {
  import type { Component } from "svelte";
  const component: Component<Record<string, unknown>>;
  export default component;
}
