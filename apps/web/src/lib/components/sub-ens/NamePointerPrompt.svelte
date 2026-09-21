<!--
  "Point punkpub.woco.eth at this site?" — the one place a holder signs a
  name's pointer (registrar v2.2). WoCo holds no key that can repoint a name,
  so every bind is the holder's signature, relayed for free.

  Asked at BIND only. A site name points at the site's feed manifest, which
  each publish advances, so publishing again never asks. An event page's feed
  is platform-signed, so its name points at the page's fixed content hash
  instead, and a redeploy asks again.

  Who may sign which pointer is decided in `sub-ens/pointer-policy.ts`.
-->
<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import { subEnsName, type SiteFeedOwner } from "@woco/shared";
  import { subEnsErrorFrom, subEnsErrorDetail } from "../../sub-ens/errors.js";
  import { pointerBlockedReason, type PointerPurpose } from "../../sub-ens/pointer-policy.js";

  interface Props {
    label: string;
    /** 64-hex Swarm reference the name should point at. */
    target: string;
    purpose: PointerPurpose;
    /** Sites only: who authors the feed behind `target`. */
    feedOwner?: SiteFeedOwner;
    ondone?: () => void;
  }

  let { label, target, purpose, feedOwner, ondone }: Props = $props();

  let phase = $state<"ask" | "working" | "done">("ask");
  let errText = $state("");

  const name = $derived(subEnsName(label));

  const blocked = $derived(pointerBlockedReason(auth.kind, purpose, feedOwner, name));

  async function point() {
    if (phase === "working" || blocked) return;
    phase = "working";
    errText = "";
    try {
      const { pointNameAt } = await import("../../sub-ens/pointer.js");
      await pointNameAt(label, target, (typed) => auth.signTypedDataAsHolder(typed));
      phase = "done";
      ondone?.();
    } catch (err) {
      const d = subEnsErrorFrom(err, "Couldn't point the name");
      const detail = subEnsErrorDetail(d);
      errText = `${d.title}${detail ? ` ${detail}` : ""}`;
      phase = "ask";
      console.error("[sub-ens] pointer failed:", err);
    }
  }
</script>

<div class="pointer" class:pointer--done={phase === "done"}>
  {#if phase === "done"}
    <span>
      {purpose === "site"
        ? `${name} now points at this site. It follows every publish from here.`
        : purpose === "event-page"
          ? `${name} now points at this event page.`
          : `${name} now opens your profile.`}
    </span>
  {:else if blocked}
    <span>{blocked}</span>
  {:else}
    <span>
      {purpose === "site"
        ? `Point ${name} at this site? You sign once; every later publish follows automatically.`
        : purpose === "event-page"
          ? `Point ${name} at this event page? You sign it from your account; we cover the fee.`
          : `Point ${name} at your profile, so typing it into a browser opens it?`}
    </span>
    <button class="btn btn--primary" onclick={point} disabled={phase === "working"}>
      {phase === "working" ? "Signing…" : "Point it here"}
    </button>
    {#if errText}<span class="pointer__error" role="alert">{errText}</span>{/if}
  {/if}
</div>

<style>
  .pointer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    margin: 0 0 0.75rem;
    padding: 0.5rem 0.75rem;
    font-size: 0.8125rem;
    line-height: 1.5;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .pointer--done {
    color: var(--text-muted);
  }
  .pointer__error {
    flex-basis: 100%;
    color: var(--error);
  }
</style>
