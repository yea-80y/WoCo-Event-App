<script lang="ts">
  /**
   * DEV-ONLY THROWAWAY — Web3Auth email-backup determinism probe (#/dev-web3auth).
   * Not in production builds (route guarded by import.meta.env.DEV). Remove this
   * file + its route in router.svelte.ts + the block in AttendeeApp.svelte once the
   * real guardian chooser (Sonnet) lands.
   *
   * Validates the two funds-critical unknowns before any UI is built on top:
   *  1. SAME KEY across runs/devices — connect twice (and on a second device with
   *     the SAME email): the returned address must be identical. That proves
   *     Web3Auth returns the same secp256k1 key for the same login everywhere.
   *  2. ESCROW DETERMINISM (the gate) — the RECOVERY_ENC typed-data signature is
   *     byte-identical on repeat signs → the X25519 escrow key is reproducible.
   */
  import { connectWeb3AuthBackup } from "../../wallet/backup-signer.js";
  import { RECOVERY_ENC_DOMAIN, RECOVERY_ENC_TYPES, RECOVERY_ENC_NONCE } from "@woco/shared";

  interface Run {
    n: number;
    address: string;
    recoveryReady: boolean;
    sigDeterministic: boolean;
    sameAsFirst: boolean;
  }

  let runs = $state<Run[]>([]);
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function probe() {
    busy = true;
    error = null;
    try {
      const backup = await connectWeb3AuthBackup();

      // Escrow-gate check: sign the fixed RECOVERY_ENC typed data twice; must match.
      const msg = {
        purpose: "Derive recovery-escrow encryption key",
        address: backup.address,
        nonce: RECOVERY_ENC_NONCE,
      };
      const sigA = await backup.signTypedData({ ...RECOVERY_ENC_DOMAIN }, RECOVERY_ENC_TYPES as never, msg);
      const sigB = await backup.signTypedData({ ...RECOVERY_ENC_DOMAIN }, RECOVERY_ENC_TYPES as never, msg);

      const firstAddr = runs[0]?.address;
      runs = [
        ...runs,
        {
          n: runs.length + 1,
          address: backup.address,
          recoveryReady: backup.recoveryReady,
          sigDeterministic: sigA === sigB,
          sameAsFirst: firstAddr ? firstAddr === backup.address : true,
        },
      ];
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div style="max-width:640px;margin:3rem auto;padding:1.5rem;font-family:system-ui;line-height:1.5;">
  <h1 style="font-size:1.25rem;">🧪 Web3Auth email-backup probe (dev only)</h1>
  <p style="color:#555;">
    Click <b>Connect</b>, log in with email. Run it <b>twice</b> (and once on a
    second device with the <b>same email</b>) — the address must match every time.
    Network: <code>{import.meta.env.VITE_WEB3AUTH_NETWORK ?? "sapphire_devnet"}</code>.
  </p>

  <button onclick={probe} disabled={busy} style="padding:.6rem 1.1rem;font-size:1rem;cursor:pointer;">
    {busy ? "Connecting…" : "Connect email backup"}
  </button>

  {#if error}
    <p style="color:#b00;margin-top:1rem;white-space:pre-wrap;"><b>Error:</b> {error}</p>
  {/if}

  {#if runs.length}
    <table style="margin-top:1.5rem;border-collapse:collapse;width:100%;font-size:.9rem;">
      <thead>
        <tr style="text-align:left;border-bottom:2px solid #ccc;">
          <th style="padding:.4rem;">#</th>
          <th style="padding:.4rem;">Address</th>
          <th style="padding:.4rem;">Same key</th>
          <th style="padding:.4rem;">Escrow sig</th>
          <th style="padding:.4rem;">Guardian</th>
        </tr>
      </thead>
      <tbody>
        {#each runs as r (r.n)}
          <tr style="border-bottom:1px solid #eee;">
            <td style="padding:.4rem;">{r.n}</td>
            <td style="padding:.4rem;font-family:monospace;font-size:.8rem;">{r.address}</td>
            <td style="padding:.4rem;">{r.sameAsFirst ? "✅" : "❌ DIFFERENT"}</td>
            <td style="padding:.4rem;">{r.sigDeterministic ? "✅ deterministic" : "❌ NON-DET"}</td>
            <td style="padding:.4rem;">{r.recoveryReady ? "✅ ready" : "❌"}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p style="margin-top:1rem;color:#555;">
      PASS = every row ✅. A ❌ in "Same key" means Web3Auth did not return the same
      key for the same login (would break cross-device recovery — stop and report).
    </p>
  {/if}
</div>
