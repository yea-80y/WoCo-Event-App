import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

const app = mount(App, {
  target: document.getElementById('app')!,
})

// Dev-only console hook for verifying cross-device feed-signer determinism —
// exposes only public addresses (never private keys). Not shipped to prod builds.
if (import.meta.env.DEV) {
  import('./lib/auth/auth-store.svelte.js').then(({ auth }) => {
    (window as unknown as { wocoDebug: unknown }).wocoDebug = {
      getContentFeedSignerAddress: () => auth.getContentFeedSignerAddress(),
      parent: () => auth.parent,
      podAddress: () => auth.podAddress,
    };
  });
}

export default app
