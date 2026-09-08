<!--
  Discard a .woco.eth name — the irreversible one.

  `release` BURNS the ERC-721 token. `owner(node)` becomes zero, the registrar's
  `available()` says true again, and anyone may re-mint the label; the registry
  keeps only `lastRelease` (who held it, when) and nothing reads it. There is no
  undo and no grace period — the 30-day previous-holder hold was examined and
  DROPPED (plan doc, 2026-09-02). So the confirmation is the label, typed: the
  one gesture a mis-click cannot produce.

  Gas is the only thing that differs by login kind (`releaseRails`). The
  AUTHORITY is always the holder's own signature.
-->
<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import { SUB_ENS_DEFAULT_CHAIN_ID, SUB_ENS_DEPLOYMENTS, subEnsName } from "@woco/shared";
  import type { Hex0x } from "@woco/shared";
  import { discardPlanFor } from "../../sub-ens/discard-availability.js";
  import { subEnsErrorFrom, subEnsErrorDetail } from "../../sub-ens/errors.js";
  import { getEthersProvider } from "../../wallet/provider.js";
  import { switchChain } from "../../payment/chains.js";

  interface Props {
    label: string;
    onclose: () => void;
    /** Fired once the burn is confirmed on-chain, so the caller can drop the row. */
    ondiscarded?: (label: string) => void;
  }

  let { label, onclose, ondiscarded }: Props = $props();

  const ensName = $derived(subEnsName(label));
  const plan = $derived(discardPlanFor(auth.kind));

  let typed = $state("");
  let phase = $state<"confirm" | "working" | "done">("confirm");
  let errTitle = $state("");
  let errDetail = $state("");
  let sponsored = $state(false);

  const matches = $derived(typed.trim().toLowerCase() === label.toLowerCase());

  /**
   * Build the rails for THIS login.
   *
   * The signer signs 32 RAW BYTES — never the hex string that spells them (see
   * `release.ts`, which explains what a text signature costs). `kernelRelease`
   * is deliberately absent: the Kernel lives on another chain than the names,
   * so a sudo op there could not touch this registry. #489 wires it when the
   * account moves; until then the AA gate above means we never get here.
   */
  async function buildRails() {
    const parent = auth.parent;
    if (!parent) throw new Error("Sign in again to discard a name.");
    // FAIL LOUD rather than sign with the wrong key. Everything below assumes an
    // EOA holder reachable through the injected wallet; a smart-account login
    // must sign through its own account, which is #489's work. Today the gate
    // above makes this unreachable — when the gate opens, this line is what
    // stops the flip shipping a signature the registry will not accept.
    if (auth.kind !== "web3") {
      throw new Error("Discarding from this account isn't wired up yet — nothing was signed.");
    }
    const { JsonRpcSigner } = await import("ethers");
    const signer = new JsonRpcSigner(await getEthersProvider(), parent);

    return {
      signInnerHash: (inner: Uint8Array) => signer.signMessage(inner),
      ...(plan.rails.includes("wallet")
        ? {
            walletRelease: async (node: Hex0x) => {
              // The wallet must be ON the names' chain to submit; the relay
              // signature above did not need it (personal_sign is chain-free).
              await switchChain(SUB_ENS_DEFAULT_CHAIN_ID);
              const { Contract } = await import("ethers");
              const fresh = new JsonRpcSigner(await getEthersProvider(), parent);
              const registry = new Contract(
                SUB_ENS_DEPLOYMENTS[SUB_ENS_DEFAULT_CHAIN_ID].registry,
                ["function release(bytes32 node)"],
                fresh,
              );
              const tx = await registry.release(node);
              await tx.wait();
              return { txHash: tx.hash as string };
            },
          }
        : {}),
    };
  }

  async function discard() {
    if (!matches || phase === "working") return;
    phase = "working";
    errTitle = "";
    errDetail = "";
    try {
      // `releaseName` runs `prepareRelease` itself — calling it here too would
      // read the registry twice and sign against a second, different expiry.
      const { releaseName } = await import("../../sub-ens/release.js");
      const { via } = await releaseName(label, await buildRails());
      sponsored = via === "relay";
      phase = "done";
      ondiscarded?.(label);
    } catch (err) {
      const described = subEnsErrorFrom(err, "Couldn't discard the name");
      errTitle = described.title;
      errDetail = subEnsErrorDetail(described) ?? "";
      phase = "confirm";
      console.error("[sub-ens] discard failed:", err);
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && phase !== "working") onclose();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="backdrop" role="presentation" onclick={() => phase !== "working" && onclose()}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div class="modal" role="dialog" aria-modal="true" aria-label="Discard name" onclick={(e) => e.stopPropagation()}>
    {#if phase === "done"}
      <h2 class="title">{ensName} is gone</h2>
      <p class="body">
        The name is released. Anyone can register it now — including you, if you
        change your mind quickly enough.
        {#if sponsored}<span class="sponsored">Done — we covered the fee.</span>{/if}
      </p>
      <div class="actions">
        <button class="btn btn--primary" onclick={onclose}>Close</button>
      </div>
    {:else if !plan.available}
      <h2 class="title">Not yet</h2>
      <p class="body">{plan.reason}</p>
      <div class="actions">
        <button class="btn" onclick={onclose}>Close</button>
      </div>
    {:else}
      <h2 class="title">Discard {ensName}?</h2>
      <p class="body">
        This burns <strong>{ensName}</strong> for good. Anyone can register it
        afterwards. Anything pointing at it — a site, an event page, your
        profile — stops resolving.
      </p>
      <label class="field">
        <span class="field-label">Type <code>{label}</code> to confirm</span>
        <input
          class="field-input"
          type="text"
          autocomplete="off"
          autocapitalize="none"
          spellcheck="false"
          bind:value={typed}
          disabled={phase === "working"}
          placeholder={label}
        />
      </label>
      {#if errTitle}
        <p class="err">{errTitle}{#if errDetail} <span class="err-detail">{errDetail}</span>{/if}</p>
      {/if}
      <div class="actions">
        <button class="btn" onclick={onclose} disabled={phase === "working"}>Cancel</button>
        <button class="btn btn--danger" onclick={discard} disabled={!matches || phase === "working"}>
          {phase === "working" ? "Discarding…" : "Discard for good"}
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 1000;
    display: flex; align-items: center; justify-content: center; padding: 1rem;
    background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(4px);
  }
  .modal {
    width: 100%; max-width: 26rem;
    background: var(--bg-elevated); border: 1.5px solid var(--border);
    border-radius: 10px; padding: 1.25rem 1.375rem;
    display: flex; flex-direction: column; gap: 0.875rem;
  }
  .title { margin: 0; font-size: 1.0625rem; font-weight: 800; color: var(--text); letter-spacing: -0.01em; }
  .body { margin: 0; font-size: 0.8125rem; line-height: 1.55; color: var(--text-muted); }
  .sponsored { display: block; margin-top: 0.4rem; color: var(--accent-text); font-weight: 700; }

  .field { display: flex; flex-direction: column; gap: 0.35rem; }
  .field-label { font-size: 0.75rem; color: var(--text-muted); }
  .field-label code { font-family: var(--font-mono); color: var(--text); }
  .field-input {
    padding: 0.5rem 0.625rem; font-family: var(--font-mono); font-size: 0.8125rem;
    color: var(--text); background: var(--bg); border: 1.5px solid var(--border);
    border-radius: 6px; outline: none;
  }
  .field-input:focus { border-color: var(--accent); }

  .err { margin: 0; font-size: 0.8125rem; line-height: 1.45; color: var(--error); }
  .err-detail { color: var(--text-muted); }

  .actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
  .btn {
    padding: 0.5rem 0.875rem; font-size: 0.8125rem; font-weight: 700; font-family: inherit;
    color: var(--text); background: none; border: 1.5px solid var(--border);
    border-radius: 6px; cursor: pointer; transition: all 120ms;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn--primary { border-color: var(--accent); color: var(--accent-text); }
  .btn--danger:not(:disabled) { color: var(--error); border-color: color-mix(in srgb, var(--error) 50%, var(--border)); }
  .btn--danger:not(:disabled):hover { background: var(--error-subtle); }
</style>
