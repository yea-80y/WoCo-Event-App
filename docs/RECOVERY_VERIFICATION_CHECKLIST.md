# Passkey Recovery — Live Verification Checklist

**Purpose:** prove the wired recover-and-rekey ceremony works end to end in a real browser
BEFORE it is advertised for funds-holding accounts or used to relax the organiser-payout gate.
The on-chain rotation and the escrow round-trip are spike-proven *individually*; this verifies
the *full wired path* (UI → ceremony → re-login → decryption).

> ⚠️ **IRREVERSIBLE.** Use a THROWAWAY passkey account. After recovery the original passkey is
> dead on-chain for that account. Do NOT run this against an account you care about.

---

## 0. Environment & prerequisites

- [ ] **Backend reachable:** run `npm run dev:server` (opens the SSH tunnel to the Hetzner bee
      so `/api/recovery/escrow` can read/write the `woco/recovery/{kernel}` feed). Confirm
      `curl http://localhost:3001/api/health` is OK. *(Writes the recovery envelope — ciphertext
      only — to the real Swarm feed; that's expected and safe.)*
- [ ] **Frontend:** `npm run dev:web`, open `http://localhost:5173` in a browser whose platform
      authenticator can make passkeys (Chrome + OS passkey, or a security key). Keep DevTools
      open (Console + Application → Storage).
- [ ] **Backup wallet:** MetaMask (or any injected wallet) installed, with **one chosen account**
      switched to **Arbitrum Sepolia (chain 421614)**. No funds needed — all userOps are
      paymaster-sponsored and the backup only signs (no gas). **Use the SAME MetaMask account for
      setup and recovery** — the guardian address is derived from it; a different account makes
      recovery revert.
- [ ] **A throwaway passkey account that already has POD-encrypted data** (so step 4 has something
      to decrypt): log in with a *new* passkey, then either **create an event and self-claim one
      ticket**, or **claim a ticket** on another event. This guarantees there is encrypted
      dashboard/ticket data tied to the POD identity.

---

## 1. Set up recovery (the "old device")

1. [ ] Logged in as the throwaway **passkey** account, navigate to **`#/protect`**.
2. [ ] **Record the account address** you are protecting. In DevTools Console run:
       ```js
       (await indexedDB.databases()) // confirms a DB exists, optional
       ```
       Easier: it's your logged-in account address — copy it from the profile/account UI. Call it
       **`TARGET`**. You will paste it at recovery time. (It is the Kernel smart-account address,
       `0x…`, 42 chars.)
3. [ ] Click **"Add a backup wallet"**. Expect this prompt sequence:
       - passkey prompt (deriving your POD identity, if not already done),
       - MetaMask **connect / pick account**,
       - MetaMask **signature #1** (derives the escrow key),
       - MetaMask **signature #2** (determinism self-check — this is intentional),
       - passkey prompt (installs the on-chain recovery route).
4. [ ] **Expected:** "Backup added / You're protected", showing the backup wallet's short address.
       - ✅ If you instead see *"signature isn't reproducible"* → your wallet's typed-data signing
         is non-deterministic; the self-check correctly blocked an unrecoverable setup. Use a
         different backup wallet. **This is a pass for the safety check.**
5. [ ] (Optional, proves funds-preservation) Send a tiny amount of Arb Sepolia test ETH to
       **`TARGET`**. Note the balance on `https://sepolia.arbiscan.io/address/<TARGET>`.

---

## 2. Simulate a lost device

The recovery portal mints a brand-new passkey and does not use the old one, so you only need to be
**logged out with local state gone**:

1. [ ] In DevTools → **Application → Storage → Clear site data** for `localhost:5173`
       (clears IndexedDB: session, cached POD seed, parent address). 
2. [ ] **Reload the page.** You should now be logged out (no account in the top bar).
       - *(The old passkey may still exist in your OS authenticator — that's fine. After recovery
         it is dead on-chain for `TARGET`, which step 5 verifies.)*

---

## 3. Recover (the "new device")

1. [ ] Navigate to **`#/recover`**.
2. [ ] **Step 1 — Connect your backup wallet:** click Connect, pick the **same MetaMask account**
       used in step 1. Confirm the short address matches.
3. [ ] **Step 2 — Which account:** paste **`TARGET`**, click **Find**.
       - ✅ Expected: **"Protected account found ✓"** with the irreversibility warning.
       - ❌ "No backup found" → wrong address, or the escrow write in step 1 failed (check
         `dev:server` was running). Fix and redo step 1.
4. [ ] Click **"Restore my account"**. Expect:
       - passkey prompt (**create a NEW passkey** on this device),
       - MetaMask **signature** (guardian userOp → `doRecovery`),
       - MetaMask **signature** (re-derives the escrow key to decrypt your identity),
       - then progress → **"Account recovered"**.
5. [ ] Click **"Go to my account"**.

---

## 4. Verify the four invariants (the actual pass/fail)

1. [ ] **Same address preserved.** Your logged-in account address now == **`TARGET`** (and the
       success screen showed `TARGET`'s short form). ✅ must match exactly.
2. [ ] **New passkey controls the account.** Do an action that makes an authenticated request —
       open **My Tickets** (or the organiser **Dashboard**, or publish). It should load / succeed
       with **no 403**. This proves the server accepted the Kernel's ERC-1271 signature, i.e. the
       on-chain owner is now your new passkey. ✅
3. [ ] **Tickets / dashboard decrypt.** The POD-encrypted data you created in step 0 is **visible
       and decrypted** (your claimed ticket appears / dashboard claim data renders). This proves
       the ORIGINAL ed25519 POD seed was restored from escrow. ✅ *(If it shows nothing-to-decrypt
       or garbled, the escrow restore failed — capture console errors.)*
4. [ ] **(Optional) Funds preserved.** Re-check `https://sepolia.arbiscan.io/address/<TARGET>` —
       the test ETH from step 1.5 is still there (same address). ✅
5. [ ] **(Optional, strongest) Old passkey is dead.** In a separate browser profile (or after
       clearing site data again), `#/` → log in with the **OLD** passkey for `TARGET`, then try an
       authenticated action. **Expected: it fails** (signature invalid / 403) because the old
       owner was rotated out on-chain. ✅
6. [ ] **RELOAD PERSISTENCE (regression for the 2026-06-20b fix — MANDATORY).** Still on the
       recovered device, **reload the page** (or close/reopen the tab), let auth restore, then do
       an authenticated action (open My Tickets / Dashboard) **and** visit `#/protect`.
       - ✅ Expected: still logged in as `TARGET`, action succeeds, `#/protect` shows **"Backup on
         record"** — NOT a login screen and NOT *"Kernel address mismatch on restore"*.
       - Proves `RECOVERED_KERNEL_BINDING` persisted and `loginPasskey`/`_ensureKernel` rebuilt at
         the preserved address. Before the fix, a recovered account bricked here.

---

## 5. What to capture / report back

- The `TARGET` address + the recovery tx hash (printed by `recoverAccount`; check the Network/
  console or arbiscan for the `doRecovery` userOp).
- Screenshot of "Account recovered".
- Pass/fail for each box in §4 (1–3 are mandatory; 4–5 optional but recommended).
- Any console errors during §3–§4.

**If §4.1–§4.3 all pass:** the wired path is verified — proceed to funds-policy wiring in
`TicketSeriesEditor` and the timelock work. **If any fail:** stop; paste the console output into
the next session before going further (this path touches funds).
