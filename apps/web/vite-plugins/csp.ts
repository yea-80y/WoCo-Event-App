/**
 * Build-time CSP injection (#146).
 *
 * The app is served from more than one origin (gateway.woco-net.com, woco.eth.limo),
 * and the gateway serves organiser sites through the same /bzz route as the app —
 * so a response-header CSP can neither cover every origin nor be scoped to the app.
 * A <meta http-equiv> policy travels with the HTML to every origin that serves it.
 * Injected only at build so the dev server (HMR websocket, esbuild deps) is untouched.
 *
 * Meta-CSP limits accepted here: frame-ancestors cannot be expressed (clickjacking
 * of the app itself stays open — a gateway-header follow-up), and there is no
 * Report-Only mode, so changes are proven with a browser pass over the login/pay
 * flows instead of a report endpoint.
 *
 * ONE POLICY PER HTML ENTRY, keyed by filename. multi-site.html is deliberately
 * absent: it is baked into organiser site collections whose allowlist (embed
 * providers, own domains) is a different audit — tracked separately, not here.
 *
 * Every origin below must name the feature that dies without it. An origin
 * without a reason gets removed.
 */
import type { IndexHtmlTransformContext, Plugin } from "vite";

type Policy = Record<string, string[]>;

/** Serialise a policy object into a CSP string. */
export function serialisePolicy(policy: Policy): string {
  return Object.entries(policy)
    .map(([directive, sources]) => (sources.length ? `${directive} ${sources.join(" ")}` : directive))
    .join("; ");
}

/**
 * Main app shell. The allowlist is the union of what the enumerated code paths
 * actually contact (audit 2026-08-23, issue #146) plus the vendor-documented
 * requirements for Stripe Connect embedded components and hCaptcha.
 *
 * Vendor-documented entries:
 * - Stripe Connect embedded components: script-src/frame-src connect-js.stripe.com +
 *   js.stripe.com, img-src *.stripe.com. Stripe also documents a style hash for an
 *   empty <style>; adding ANY hash to style-src makes browsers ignore
 *   'unsafe-inline', which Web3Auth's modal and Reown AppKit need for their
 *   injected <style> elements — so the hash is deliberately omitted.
 *   Checkout and Connect onboarding are top-level redirects, which CSP does not gate.
 * - hCaptcha (Web3Auth's email login embeds it in OUR document): script/frame/
 *   style/connect for hcaptcha.com + *.hcaptcha.com. Their docs forbid pinning
 *   subdomains ("asset subdomains vary over time or by region").
 *
 * Deliberately excluded (re-add only with a named breakage):
 * - cdn.segment.com / api.segment.io — Web3Auth's product analytics. We pass
 *   disableAnalytics instead (web3auth-config.ts), so nothing ever loads it.
 * - pulse.walletconnect.org — WalletConnect analytics batch endpoint.
 * - metadata.tor.us, node-*.web3auth.io — key-share traffic runs inside the
 *   auth.web3auth.io iframe (its own origin), not ours.
 * - rpc.ankr.com — web3auth-config's rpcTarget placeholder; validated, never called.
 * - wallet.web3auth.io — ws-embed is unreachable under CHAIN_NAMESPACES.OTHER.
 * - secure.walletconnect.org / echo.walletconnect.com — email-wallet + push,
 *   neither enabled.
 *
 * Known degradations accepted:
 * - Import-from-URL preview thumbnails (ImportUrlPanel) can point at any origin;
 *   under a named img-src the preview image breaks, the import itself does not.
 * - VITE_OWNER_SCAN_FALLBACK_RPCS entries beyond the default Arbitrum endpoint
 *   need adding here too, or the owner scan silently loses its fallback.
 */
const APP_POLICY: Policy = {
  "default-src": ["'self'"],
  "base-uri": ["'self'"],
  "object-src": ["'none'"],
  "form-action": ["'self'"],
  "script-src": [
    "'self'",
    "https://connect-js.stripe.com", // Connect embedded components loader (payouts screen)
    "https://js.stripe.com", // loaded BY connect.js per Stripe's documented CSP
    "https://hcaptcha.com",
    "https://*.hcaptcha.com", // Web3Auth email-login captcha, loaded into our document
  ],
  "style-src": [
    "'self'",
    "'unsafe-inline'", // Web3Auth modal + Reown AppKit inject <style>; 27 components use style= attributes
    "https://fonts.googleapis.com",
    "https://hcaptcha.com",
    "https://*.hcaptcha.com",
  ],
  "font-src": [
    "'self'",
    "https://fonts.gstatic.com",
    "https://fonts.reown.com", // AppKit preloads its KHTeka face on modal theme init
  ],
  "img-src": [
    "'self'",
    "data:", // inline SVG textures, QR toDataURL previews
    "blob:", // image resize + logo preview object URLs
    "https://gateway.woco-net.com", // Swarm content: event images, avatars, POD art
    "https://gateway.etherna.io", // Swarm image fallback gateway
    "https://images.web3auth.io", // login-method icons in the Web3Auth modal
    "https://web3auth.io", // modal logo configured in web3auth-config.ts
    "https://api.web3modal.org", // wallet logos in the WalletConnect QR modal
    "https://*.stripe.com", // Connect embedded components, per Stripe's documented CSP
  ],
  "connect-src": [
    "'self'",
    "https://events-api.woco-net.com", // the API (fetch + sendBeacon)
    "https://gateway.woco-net.com", // Swarm reads (bytes/chunks/feeds)
    "https://gateway.etherna.io",
    "https://rpc.zerodev.app", // Kernel bundler/paymaster RPC (VITE_ZERODEV_RPC)
    "https://sepolia-rollup.arbitrum.io", // owned-accounts scan fallback RPC
    "https://api.web3auth.io", // project config, passwordless, session services
    "https://session.web3auth.io", // socket.io https polling fallback…
    "wss://session.web3auth.io", // …and its websocket upgrade
    "https://assets.web3auth.io", // wallet-registry JSON for the modal
    "wss://relay.walletconnect.org", // the WalletConnect session itself
    "https://rpc.walletconnect.org", // WC provider default rpcMap
    "https://api.web3modal.org", // QR modal wallet list
    "https://verify.walletconnect.org", // WC Verify attestation
    "https://api.stripe.com", // AccountSession traffic from connect.js
    "https://rpc.wallet.coinbase.com", // Coinbase provider read RPC
    "https://www.walletlink.org", // Coinbase mobile-app relay…
    "wss://www.walletlink.org", // …and its websocket
    "https://photon.komoot.io", // venue geocoding autocomplete
    "https://hcaptcha.com",
    "https://*.hcaptcha.com",
  ],
  "frame-src": [
    "'self'", // builder live preview iframes ./multi-site.html
    "https://auth.web3auth.io", // the login ceremony iframe/popup
    "https://verify.walletconnect.org", // hidden attestation iframe
    "https://connect-js.stripe.com", // embedded component iframes
    "https://js.stripe.com",
    "https://hcaptcha.com",
    "https://*.hcaptcha.com",
  ],
  "worker-src": [
    "'self'",
    "blob:", // qr-scanner's fallback worker when BarcodeDetector is unavailable
  ],
};

/**
 * The standalone lap-count verification page: no sign-in, no wallets, no payment.
 * It talks to the indexer API and the Swarm gateway, loads the shared fonts, and
 * nothing else — so it starts from 'none' rather than inheriting the app policy.
 */
const VERIFY_POLICY: Policy = {
  "default-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'none'"],
  "script-src": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  "font-src": ["https://fonts.gstatic.com"],
  "img-src": ["'self'", "data:"],
  "connect-src": [
    "'self'",
    "https://events-api.woco-net.com", // manifest + evidence pages from the indexer
    "https://gateway.woco-net.com", // spot-check chunk reads
  ],
};

const POLICIES: Record<string, Policy> = {
  "index.html": APP_POLICY,
  "verify.html": VERIFY_POLICY,
};

export function cspInject(): Plugin {
  return {
    name: "woco:csp-inject",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html: string, ctx: IndexHtmlTransformContext) {
        const name = ctx.filename.split("/").pop() ?? "";
        const policy = POLICIES[name];
        if (!policy) return;
        return [
          {
            tag: "meta",
            attrs: {
              "http-equiv": "Content-Security-Policy",
              content: serialisePolicy(policy),
            },
            injectTo: "head-prepend" as const,
          },
        ];
      },
    },
  };
}
