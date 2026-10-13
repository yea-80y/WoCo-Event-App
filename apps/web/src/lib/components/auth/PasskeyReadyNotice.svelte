<script lang="ts">
  /**
   * Before "Create": says what this device needs to save a WoCo passkey, when the
   * browser says it can't yet (`passkey-readiness.ts`). Advice only - nothing is
   * hidden or disabled, because the check can be wrong and email/Google never need it.
   */
  import { onMount } from "svelte";
  import { checkPasskeyReadiness, type PasskeyReadiness } from "../../auth/passkey-readiness.js";
  import { passkeyNoPrfNotice, passkeyNotReadyNotice } from "../../auth/passkey-refusal-copy.js";

  interface Props {
    /** An organiser (invite or onboarding): no email fallback is offered. */
    invite?: boolean;
  }
  let { invite = false }: Props = $props();

  let readiness = $state<PasskeyReadiness>({ kind: "ok" });

  onMount(() => {
    void checkPasskeyReadiness().then((r) => (readiness = r));
  });

  const text = $derived(
    readiness.kind === "no-provider"
      ? passkeyNotReadyNotice(readiness.device, invite)
      : readiness.kind === "no-prf"
        ? passkeyNoPrfNotice(invite)
        : null,
  );
</script>

{#if text}
  <p class="ready-notice" role="note">{text}</p>
{/if}

<style>
  .ready-notice {
    margin: 0;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 0.8125rem;
    line-height: 1.45;
  }
</style>
