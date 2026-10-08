import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { auth } from './lib/auth/auth-store.svelte.js'

// The email -> passkey upgrade (#746) is loaded from here, not by the store: the
// deployed-site builds share the store, and their files are baked into every site.
auth.registerUpgradeFlow(() =>
  Promise.all([import('./lib/auth/upgrade-to-passkey.js'), import('./lib/auth/upgrade-to-passkey-live.js')]),
)

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
      seedAddress: () => auth.seedAddress,
    };
  });
}

export default app
