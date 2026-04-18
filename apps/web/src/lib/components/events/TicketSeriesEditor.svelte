<script lang="ts">
  import type { PaymentConfig, PaymentChainId, Hex0x } from "@woco/shared";
  import { CHAIN_NAMES, PLATFORM_FEE_BP } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import StripeConnectModal from "../dashboard/StripeConnectModal.svelte";
  import ConnectWalletModal from "../profile/ConnectWalletModal.svelte";
  import { isWalletAvailable } from "../../wallet/provider.js";
  import { getConnectedAddress } from "../../wallet/connection.js";
  import { onMount } from "svelte";

  interface WaveItem {
    id: string;
    label: string;
    totalSupply: number;
    saleStart: string;
    saleEnd: string;
    showSaleWindow: boolean;
  }

  interface TierGroup {
    id: string;
    tierName: string;
    description: string;
    approvalRequired: boolean;
    waves: WaveItem[];
    /** Whether this tier is a paid ticket */
    isPaid: boolean;
    /** Price as decimal string (fiat) */
    price: string;
    /** Fiat currency for pricing */
    currency: "USD" | "GBP" | "EUR";
    /** Accept crypto payments (ETH/USDC, converted from fiat at claim time) */
    cryptoEnabled: boolean;
    /** Accepted chains for crypto */
    acceptedChains: PaymentChainId[];
    /** Accept Stripe card payments */
    stripeEnabled: boolean;
    /** Pass processing fees to the buyer (default: true) */
    feePassedToCustomer: boolean;
  }

  interface SeriesDraft {
    seriesId: string;
    name: string;
    description: string;
    totalSupply: number;
    approvalRequired?: boolean;
    wave?: string;
    saleStart?: string;
    saleEnd?: string;
    payment?: PaymentConfig;
  }

  interface Props {
    series: SeriesDraft[];
    /**
     * True when crypto is enabled on at least one tier but no payout wallet has
     * been connected. Bound back to the parent so the publish button can be
     * disabled until the organiser provides a recipient address.
     */
    cryptoRecipientMissing?: boolean;
  }

  let { series = $bindable(), cryptoRecipientMissing = $bindable(false) }: Props = $props();

  let stripeModalOpen = $state(false);
  let stripeModalTierId = $state<string | null>(null);
  let walletModalOpen = $state(false);

  /** Whether the current auth identity owns a real EVM wallet. */
  const hasNativeWallet = $derived(auth.kind === "web3" || auth.kind === "para");

  /**
   * Crypto payout recipient address — separate from auth identity.
   *
   * - web3/para users: auto-set to auth.parent (their wallet IS the payout address).
   * - passkey/local users: must explicitly connect a wallet to receive crypto.
   *   `auth.parent` for these users is a passkey/browser key — NOT something
   *   they can withdraw funds from on-chain.
   */
  let cryptoRecipientAddress = $state<string | null>(null);

  function handleWalletConnected(addr: string) {
    cryptoRecipientAddress = addr.toLowerCase();
    walletModalOpen = false;
  }

  function truncateAddr(a: string): string {
    return `${a.slice(0, 6)}...${a.slice(-4)}`;
  }

  function handleStripeToggle(tier: TierGroup, checked: boolean) {
    if (checked) {
      // Opening the modal — don't enable yet, wait for connection
      stripeModalTierId = tier.id;
      stripeModalOpen = true;
    } else {
      tier.stripeEnabled = false;
    }
  }

  function handleStripeConnected() {
    // Stripe is fully connected — enable the toggle for the tier that triggered it
    if (stripeModalTierId) {
      const tier = tierGroups.find(t => t.id === stripeModalTierId);
      if (tier) tier.stripeEnabled = true;
    }
    stripeModalOpen = false;
    stripeModalTierId = null;
  }

  function handleStripeModalClose() {
    // Closed without connecting — don't enable the toggle
    stripeModalOpen = false;
    stripeModalTierId = null;
  }

  let tierGroups = $state<TierGroup[]>([{
    id: crypto.randomUUID(),
    tierName: "General Admission",
    description: "",
    approvalRequired: false,
    isPaid: false,
    price: "",
    currency: "GBP",
    cryptoEnabled: true,
    acceptedChains: [8453] as PaymentChainId[],
    stripeEnabled: false,
    feePassedToCustomer: true,
    waves: [{
      id: crypto.randomUUID(),
      label: "",
      totalSupply: 10,
      saleStart: "",
      saleEnd: "",
      showSaleWindow: false,
    }],
  }]);

  /** True when at least one tier has crypto enabled — controls whether to show the recipient prompt */
  const anyCryptoEnabled = $derived(tierGroups.some((t) => t.isPaid && t.cryptoEnabled));

  // Push the missing-recipient state up to the parent so PublishButton can disable.
  $effect(() => {
    cryptoRecipientMissing = anyCryptoEnabled && !cryptoRecipientAddress;
  });

  onMount(async () => {
    // Native-wallet users: payout goes to their auth address by default.
    if (hasNativeWallet && auth.parent) {
      cryptoRecipientAddress = auth.parent.toLowerCase();
      return;
    }
    // Passkey/local: see if they already have an external wallet connected
    if (isWalletAvailable()) {
      const addr = await getConnectedAddress();
      if (addr) cryptoRecipientAddress = addr;
    }
  });

  // Keep recipient in sync if auth changes (e.g. user finishes Para login mid-form)
  $effect(() => {
    if (hasNativeWallet && auth.parent && !cryptoRecipientAddress) {
      cryptoRecipientAddress = auth.parent.toLowerCase();
    }
  });

  // Keep series in sync with tier groups
  $effect(() => {
    const built = tierGroups.flatMap(tier =>
      tier.waves.map(wave => {
        const base: SeriesDraft = {
          seriesId: wave.id,
          name: tier.waves.length > 1 && wave.label.trim()
            ? `${tier.tierName.trim()} — ${wave.label.trim()}`
            : tier.tierName.trim(),
          description: tier.description.trim(),
          totalSupply: wave.totalSupply,
          approvalRequired: tier.approvalRequired,
          ...(tier.waves.length > 1 && wave.label.trim() ? { wave: wave.label.trim() } : {}),
          ...(wave.saleStart ? { saleStart: wave.saleStart } : {}),
          ...(wave.saleEnd ? { saleEnd: wave.saleEnd } : {}),
        };
        if (tier.isPaid && tier.price && parseFloat(tier.price) > 0) {
          // Crypto payments need a real EVM recipient. Fall back to "0x0" only when
          // crypto is disabled — the payment config is still required for Stripe-only
          // flows but won't be used to send funds. Publish is blocked above when
          // cryptoRecipientMissing is true, so we should never actually ship "0x0"
          // for a crypto-enabled series.
          const recipient = cryptoRecipientAddress ?? (tier.cryptoEnabled ? null : "0x0");
          base.payment = {
            price: tier.price,
            currency: tier.currency,
            recipientAddress: (recipient ?? "0x0") as Hex0x,
            acceptedChains: tier.cryptoEnabled ? tier.acceptedChains : [],
            escrow: tier.cryptoEnabled, // escrow for crypto payments
            cryptoEnabled: tier.cryptoEnabled,
            stripeEnabled: tier.stripeEnabled,
            feePassedToCustomer: tier.feePassedToCustomer,
          };
        }
        return base;
      })
    );
    console.log("[TicketSeriesEditor] series built:", built.map(s => ({ name: s.name, payment: s.payment })));
    series = built;
  });

  const CURRENCY_SYMBOLS: Record<string, string> = { GBP: "£", USD: "$", EUR: "€" };

  /** Stripe processing fee estimates (UK/EU domestic cards) */
  const STRIPE_PERCENT = 0.029; // 2.9% (Connect includes +0.5%)
  const STRIPE_FIXED: Record<string, number> = { GBP: 0.20, USD: 0.30, EUR: 0.25 };

  function feeBreakdown(price: string, currency: string, passToCustomer: boolean, hasStripe: boolean, hasCrypto: boolean) {
    const amount = parseFloat(price);
    if (!amount || amount <= 0) return null;
    const sym = CURRENCY_SYMBOLS[currency] ?? "";
    const fmt = (n: number) => `${sym}${n.toFixed(2)}`;
    const stripeFee = hasStripe ? amount * STRIPE_PERCENT + (STRIPE_FIXED[currency] ?? 0.20) : 0;
    const platformFee = amount * PLATFORM_FEE_BP / 10_000;

    if (passToCustomer) {
      // Buyer pays the fees — organiser receives the full ticket price
      const cardTotal = amount + stripeFee + platformFee;
      const cryptoTotal = amount + platformFee;
      return {
        mode: "pass" as const,
        basePrice: fmt(amount),
        stripeFee: hasStripe ? `~${fmt(stripeFee)}` : null,
        platformFee: fmt(platformFee),
        cardTotal: hasStripe ? `~${fmt(cardTotal)}` : null,
        cryptoTotal: hasCrypto ? fmt(cryptoTotal) : null,
        payout: fmt(amount),
      };
    } else {
      // Organiser absorbs fees — buyer pays the ticket price only
      const payoutCard = amount - stripeFee - platformFee;
      const payoutCrypto = amount - platformFee;
      return {
        mode: "absorb" as const,
        basePrice: fmt(amount),
        stripeFee: hasStripe ? `~${fmt(stripeFee)}` : null,
        platformFee: fmt(platformFee),
        cardTotal: null,
        cryptoTotal: null,
        payoutCard: hasStripe ? `~${fmt(Math.max(0, payoutCard))}` : null,
        payoutCrypto: hasCrypto ? fmt(Math.max(0, payoutCrypto)) : null,
        payout: hasStripe ? `~${fmt(Math.max(0, payoutCard))}` : fmt(Math.max(0, payoutCrypto)),
      };
    }
  }

  function addTier() {
    tierGroups.push({
      id: crypto.randomUUID(),
      tierName: "",
      description: "",
      approvalRequired: false,
      isPaid: false,
      price: "",
      currency: "GBP",
      cryptoEnabled: true,
      acceptedChains: [8453] as PaymentChainId[],
      stripeEnabled: false,
      feePassedToCustomer: true,
      waves: [{
        id: crypto.randomUUID(),
        label: "",
        totalSupply: 10,
        saleStart: "",
        saleEnd: "",
        showSaleWindow: false,
      }],
    });
  }

  function removeTier(id: string) {
    const idx = tierGroups.findIndex(t => t.id === id);
    if (idx !== -1) tierGroups.splice(idx, 1);
  }

  function addWave(tierId: string) {
    const tier = tierGroups.find(t => t.id === tierId);
    if (tier) {
      tier.waves.push({
        id: crypto.randomUUID(),
        label: "",
        totalSupply: 10,
        saleStart: "",
        saleEnd: "",
        showSaleWindow: false,
      });
    }
  }

  function removeWave(tierId: string, waveId: string) {
    const tier = tierGroups.find(t => t.id === tierId);
    if (tier && tier.waves.length > 1) {
      const idx = tier.waves.findIndex(w => w.id === waveId);
      if (idx !== -1) tier.waves.splice(idx, 1);
    }
  }
</script>

<div class="tiers-editor">
  <h3>Ticket tiers</h3>

  {#if anyCryptoEnabled}
    <div class="crypto-recipient-card" class:crypto-recipient-card--missing={cryptoRecipientMissing}>
      <div class="crypto-recipient-header">
        <span class="crypto-recipient-title">Crypto payout address</span>
        <span class="crypto-recipient-sub">
          {#if hasNativeWallet}
            Funds from crypto sales are sent to your connected wallet (or escrow until event ends).
          {:else}
            You're signed in with a {auth.kind === "passkey" ? "passkey" : "browser account"}.
            Connect a real EVM wallet to receive crypto payments — your sign-in identity can't hold funds on-chain.
          {/if}
        </span>
      </div>
      {#if cryptoRecipientAddress}
        <div class="crypto-recipient-row">
          <span class="crypto-recipient-addr" title={cryptoRecipientAddress}>{truncateAddr(cryptoRecipientAddress)}</span>
          {#if !hasNativeWallet}
            <button type="button" class="crypto-recipient-btn-link" onclick={() => walletModalOpen = true}>
              Change
            </button>
          {/if}
        </div>
      {:else}
        <button type="button" class="crypto-recipient-btn" onclick={() => walletModalOpen = true}>
          Connect wallet for crypto payouts
        </button>
        <p class="crypto-recipient-warn">
          You won't be able to publish until you connect a wallet, or disable crypto on all tiers.
        </p>
      {/if}
    </div>
  {/if}

  {#each tierGroups as tier, i (tier.id)}
    <div class="tier-card">
      <div class="tier-card-header">
        <span class="tier-card-title">
          Tier {i + 1}
          {#if tier.tierName.trim()}
            <span class="tier-name-preview">— {tier.tierName.trim()}</span>
          {/if}
        </span>
        {#if tierGroups.length > 1}
          <button class="remove-btn" onclick={() => removeTier(tier.id)} type="button" aria-label="Remove tier">✕</button>
        {/if}
      </div>

      <div class="tier-card-body">
        <label class="field">
          <span class="field-label">Tier name <span class="required">*</span></span>
          <input type="text" bind:value={tier.tierName} placeholder="e.g. General Admission, VIP" />
        </label>

        <label class="field">
          <span class="field-label">Description</span>
          <input type="text" bind:value={tier.description} placeholder="What's included" />
        </label>

        <label class="approval-toggle">
          <input type="checkbox" bind:checked={tier.approvalRequired} />
          <span class="approval-label">Require organiser approval</span>
          <span class="approval-hint">Attendees submit a request; you approve each one from the dashboard</span>
        </label>

        <!-- Payment config -->
        <label class="approval-toggle">
          <input type="checkbox" bind:checked={tier.isPaid} />
          <span class="approval-label">Paid ticket</span>
          <span class="approval-hint">Set a price — attendees can pay with crypto and/or card</span>
        </label>

        {#if tier.isPaid}
          <div class="payment-config">
            <div class="payment-row">
              <label class="field payment-price-field">
                <span class="field-label">Price</span>
                <input type="text" bind:value={tier.price} placeholder="e.g. 10.00" inputmode="decimal" />
              </label>
              <label class="field payment-currency-field">
                <span class="field-label">Currency</span>
                <select bind:value={tier.currency}>
                  <option value="GBP">GBP</option>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                </select>
              </label>
            </div>

            <div class="payment-methods">
              <span class="field-label">Payment methods</span>

              <label class="chain-check">
                <input type="checkbox" bind:checked={tier.cryptoEnabled} />
                <span>Crypto (ETH/USDC — converted from {tier.currency} at claim time)</span>
              </label>

              {#if tier.cryptoEnabled}
                <div class="payment-chains" style="margin-left: 1.5rem; margin-top: 0.25rem;">
                  <span class="field-label" style="font-size: 0.6875rem;">Networks</span>
                  <div class="chain-checkboxes">
                    {#each [[8453, "Base"], [10, "Optimism"], [1, "Ethereum"], [11155111, "Sepolia (testnet)"]] as [chainId, name]}
                      <label class="chain-check">
                        <input
                          type="checkbox"
                          checked={tier.acceptedChains.includes(chainId as PaymentChainId)}
                          onchange={(e) => {
                            const cid = chainId as PaymentChainId;
                            if ((e.target as HTMLInputElement).checked) {
                              if (!tier.acceptedChains.includes(cid)) tier.acceptedChains = [...tier.acceptedChains, cid];
                            } else {
                              tier.acceptedChains = tier.acceptedChains.filter(c => c !== cid);
                            }
                          }}
                        />
                        <span>{name}</span>
                      </label>
                    {/each}
                  </div>
                </div>
              {/if}

              <label class="chain-check">
                <input
                  type="checkbox"
                  checked={tier.stripeEnabled}
                  onchange={(e) => handleStripeToggle(tier, (e.target as HTMLInputElement).checked)}
                />
                <span>Card payments via Stripe</span>
              </label>
              {#if tier.stripeEnabled}
                <div class="stripe-connected-badge">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <circle cx="7" cy="7" r="6" fill="var(--success)" opacity="0.15"/>
                    <path d="M4 7.5L6 9.5L10 5" stroke="var(--success)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                  <span>Stripe connected</span>
                </div>
              {/if}
            </div>

            {#if (tier.stripeEnabled || tier.cryptoEnabled) && tier.price && parseFloat(tier.price) > 0}
              <!-- Fee handling toggle -->
              <div class="fee-mode">
                <span class="fee-mode-label">Who pays the fees?</span>
                <div class="fee-mode-toggle">
                  <button
                    type="button"
                    class="fee-mode-btn"
                    class:fee-mode-btn--active={tier.feePassedToCustomer}
                    onclick={() => { tier.feePassedToCustomer = true; }}
                  >Buyer pays</button>
                  <button
                    type="button"
                    class="fee-mode-btn"
                    class:fee-mode-btn--active={!tier.feePassedToCustomer}
                    onclick={() => { tier.feePassedToCustomer = false; }}
                  >I absorb</button>
                </div>
              </div>

              {@const fees = feeBreakdown(tier.price, tier.currency, tier.feePassedToCustomer, tier.stripeEnabled, tier.cryptoEnabled)}
              {#if fees}
                <div class="fee-breakdown">
                  {#if fees.mode === "pass"}
                    <span class="fee-breakdown-title">Buyer pays (per ticket)</span>
                    {#if tier.stripeEnabled}
                      <div class="fee-breakdown-col">
                        <span class="fee-col-label">Card checkout</span>
                        <div class="fee-row"><span>Ticket price</span><span>{fees.basePrice}</span></div>
                        <div class="fee-row fee-deduction"><span>Processing (~2.9% + fixed)</span><span>+{fees.stripeFee}</span></div>
                        <div class="fee-row fee-deduction"><span>Platform (1.5%)</span><span>+{fees.platformFee}</span></div>
                        <div class="fee-row fee-total"><span>Card total</span><span>{fees.cardTotal}</span></div>
                      </div>
                    {/if}
                    {#if tier.cryptoEnabled}
                      <div class="fee-breakdown-col">
                        <span class="fee-col-label">Crypto checkout</span>
                        <div class="fee-row"><span>Ticket price</span><span>{fees.basePrice}</span></div>
                        <div class="fee-row fee-deduction"><span>Platform (1.5%)</span><span>+{fees.platformFee}</span></div>
                        <div class="fee-row fee-total"><span>Crypto total</span><span>{fees.cryptoTotal}</span></div>
                      </div>
                    {/if}
                    <div class="fee-payout-line">
                      <span>You receive</span><span class="fee-payout-value">{fees.payout}</span>
                    </div>
                  {:else}
                    <span class="fee-breakdown-title">Your payout (per ticket)</span>
                    <div class="fee-row"><span>Ticket price</span><span>{fees.basePrice}</span></div>
                    <div class="fee-row fee-deduction"><span>Platform (1.5%)</span><span>−{fees.platformFee}</span></div>
                    {#if tier.stripeEnabled}
                      <div class="fee-row fee-deduction"><span>Stripe processing</span><span>−{fees.stripeFee}</span></div>
                      <div class="fee-row fee-total"><span>Card payout</span><span>{fees.payoutCard}</span></div>
                    {/if}
                    {#if tier.cryptoEnabled}
                      {#if tier.stripeEnabled}
                        <div class="fee-row fee-total" style="border-top: none; padding-top: 0; margin-top: 0;">
                          <span>Crypto payout</span><span>{fees.payoutCrypto}</span>
                        </div>
                      {:else}
                        <div class="fee-row fee-total"><span>You receive</span><span>{fees.payoutCrypto}</span></div>
                      {/if}
                    {/if}
                  {/if}
                </div>
              {/if}
            {/if}
          </div>
        {/if}

        <!-- Sale waves -->
        <div class="waves-section">
          <div class="waves-header">
            <span class="waves-label">Sale waves</span>
            {#if tier.waves.length === 1}
              <span class="waves-hint">Add waves to split capacity by sale period (e.g. Early Bird → Standard)</span>
            {/if}
          </div>

          <div class="waves-col-labels" class:has-label={tier.waves.length > 1}>
            {#if tier.waves.length > 1}<span>Wave label</span>{/if}
            <span>Quantity</span>
            <span></span>
          </div>

          {#each tier.waves as wave, wi (wave.id)}
            <div class="wave-row">
              <div class="wave-row-fields" class:has-label={tier.waves.length > 1}>
                {#if tier.waves.length > 1}
                  <input
                    class="wave-label-input"
                    type="text"
                    placeholder="e.g. Early Bird"
                    bind:value={wave.label}
                  />
                {/if}
                <input
                  class="wave-supply-input"
                  type="number"
                  min="1"
                  bind:value={wave.totalSupply}
                />
                <button
                  class="wave-window-btn"
                  class:active={wave.showSaleWindow}
                  type="button"
                  onclick={() => { wave.showSaleWindow = !wave.showSaleWindow; }}
                  title="Set sale window"
                >
                  {#if wave.saleStart || wave.saleEnd}
                    <span class="wave-date-summary">
                      {wave.saleStart ? wave.saleStart.slice(0, 10) : "…"}
                      {#if wave.saleEnd}&nbsp;→&nbsp;{wave.saleEnd.slice(0, 10)}{/if}
                    </span>
                  {:else}
                    <span>Sale window</span>
                  {/if}
                  <span class="chevron">{wave.showSaleWindow ? "▲" : "▼"}</span>
                </button>
                {#if tier.waves.length > 1}
                  <button class="remove-btn remove-btn--sm" onclick={() => removeWave(tier.id, wave.id)} type="button" aria-label="Remove wave">✕</button>
                {/if}
              </div>

              {#if wave.showSaleWindow}
                <div class="sale-window-fields">
                  <label class="field">
                    <span class="field-label">Opens</span>
                    <input type="datetime-local" bind:value={wave.saleStart} />
                  </label>
                  <label class="field">
                    <span class="field-label">Closes</span>
                    <input type="datetime-local" bind:value={wave.saleEnd} />
                  </label>
                </div>
              {/if}
            </div>
          {/each}

          <button class="add-wave-btn" type="button" onclick={() => addWave(tier.id)}>+ Add wave</button>
        </div>
      </div>
    </div>
  {/each}

  <button class="add-tier-btn" onclick={addTier} type="button">
    + Add tier
  </button>
</div>

<StripeConnectModal
  bind:open={stripeModalOpen}
  onclose={handleStripeModalClose}
  onconnected={handleStripeConnected}
/>

{#if walletModalOpen}
  <ConnectWalletModal
    onConnect={handleWalletConnected}
    onClose={() => walletModalOpen = false}
  />
{/if}

<style>
  .tiers-editor {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  h3 {
    margin: 0;
    color: var(--text);
    font-size: 1rem;
    font-weight: 600;
  }

  /* ── Tier card ── */
  .tier-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .tier-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0.75rem;
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border);
  }

  .tier-card-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .tier-name-preview {
    color: var(--text-muted);
    font-weight: 400;
  }

  .tier-card-body {
    padding: 0.875rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  /* ── Fields ── */
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .field-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .required {
    color: var(--error);
  }

  .field input[type="text"],
  .field input[type="datetime-local"] {
    padding: 0.375rem 0.5rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.8125rem;
    font-family: inherit;
  }

  .field input:focus {
    outline: none;
    border-color: var(--accent);
  }

  /* ── Approval toggle ── */
  .approval-toggle {
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    gap: 0.5rem;
    cursor: pointer;
    flex-wrap: wrap;
  }

  .approval-toggle input[type="checkbox"] {
    margin-top: 0.125rem;
    width: 0.9rem;
    height: 0.9rem;
    accent-color: var(--accent);
    flex-shrink: 0;
  }

  .approval-label {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    font-weight: 500;
  }

  .approval-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    font-weight: 400;
    width: 100%;
    margin-left: 1.4rem;
  }

  /* ── Waves ── */
  .waves-section {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    border-top: 1px dashed var(--border);
    padding-top: 0.75rem;
    margin-top: 0.125rem;
  }

  .waves-header {
    display: flex;
    align-items: baseline;
    gap: 0.625rem;
    flex-wrap: wrap;
    margin-bottom: 0.125rem;
  }

  .waves-label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .waves-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .waves-col-labels {
    display: grid;
    grid-template-columns: 90px auto 24px;
    gap: 0.5rem;
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0 0.125rem;
  }

  .waves-col-labels.has-label {
    grid-template-columns: 1fr 90px auto 24px;
  }

  .wave-row {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .wave-row-fields {
    display: grid;
    grid-template-columns: 90px auto 24px;
    gap: 0.5rem;
    align-items: center;
  }

  .wave-row-fields.has-label {
    grid-template-columns: 1fr 90px auto 24px;
  }

  .wave-label-input,
  .wave-supply-input {
    padding: 0.375rem 0.5rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.8125rem;
    font-family: inherit;
    width: 100%;
  }

  .wave-label-input:focus,
  .wave-supply-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .wave-window-btn {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.375rem 0.5rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    color: var(--text-muted);
    white-space: nowrap;
    transition: all var(--transition);
    width: 100%;
    justify-content: space-between;
  }

  .wave-window-btn:hover,
  .wave-window-btn.active {
    border-color: var(--accent);
    color: var(--accent-text);
  }

  .wave-date-summary {
    font-size: 0.6875rem;
    color: var(--accent-text);
  }

  .chevron {
    font-size: 0.5625rem;
    opacity: 0.6;
  }

  .sale-window-fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
    padding: 0.5rem 0.625rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  @media (max-width: 480px) {
    .sale-window-fields {
      grid-template-columns: 1fr;
    }

    .field input[type="datetime-local"] {
      width: 100%;
      min-width: 0;
    }

    .wave-row-fields,
    .wave-row-fields.has-label {
      grid-template-columns: 1fr;
      gap: 0.375rem;
    }

    .waves-col-labels,
    .waves-col-labels.has-label {
      display: none;
    }

    .wave-supply-input {
      max-width: none;
    }
  }

  /* ── Remove buttons ── */
  .remove-btn {
    color: var(--text-muted);
    font-size: 0.75rem;
    transition: color var(--transition);
    line-height: 1;
  }

  .remove-btn:hover {
    color: var(--error);
  }

  .remove-btn--sm {
    font-size: 0.6875rem;
    padding: 0.125rem 0.25rem;
  }

  /* ── Add buttons ── */
  .add-wave-btn {
    align-self: flex-start;
    font-size: 0.8125rem;
    color: var(--accent-text);
    padding: 0.25rem 0;
    transition: opacity var(--transition);
  }

  .add-wave-btn:hover {
    opacity: 0.75;
  }

  .add-tier-btn {
    padding: 0.625rem;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    color: var(--accent-text);
    font-size: 0.875rem;
    transition: all var(--transition);
  }

  .add-tier-btn:hover {
    border-color: var(--accent);
    background: var(--accent-subtle);
  }

  /* ── Payment config ── */
  .payment-config {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 0.625rem 0.75rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .payment-row {
    display: flex;
    gap: 0.5rem;
  }

  .payment-price-field {
    flex: 1;
  }

  .payment-currency-field {
    width: 5rem;
  }

  .payment-currency-field select {
    width: 100%;
    padding: 0.375rem 0.5rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.8125rem;
    font-family: inherit;
  }

  .payment-chains {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .chain-checkboxes {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .chain-check {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    cursor: pointer;
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }

  .chain-check input[type="checkbox"] {
    width: 0.875rem;
    height: 0.875rem;
    accent-color: var(--accent);
  }

  /* ── Fee mode toggle ── */
  .fee-mode {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .fee-mode-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .fee-mode-toggle {
    display: flex;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .fee-mode-btn {
    padding: 0.3125rem 0.625rem;
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-muted);
    transition: all var(--transition);
    white-space: nowrap;
  }

  .fee-mode-btn:hover {
    color: var(--text-secondary);
  }

  .fee-mode-btn--active {
    background: var(--accent);
    color: #fff;
  }

  .fee-mode-btn--active:hover {
    color: #fff;
  }

  /* ── Fee breakdown ── */
  .fee-breakdown {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.625rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
  }

  .fee-breakdown-title {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 0.25rem;
  }

  .fee-breakdown-col {
    display: flex;
    flex-direction: column;
    gap: 0.1875rem;
    margin-bottom: 0.375rem;
  }

  .fee-col-label {
    font-size: 0.625rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.0625rem;
  }

  .fee-row {
    display: flex;
    justify-content: space-between;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .fee-deduction {
    color: var(--text-muted);
  }

  .fee-total {
    border-top: 1px solid var(--border);
    padding-top: 0.25rem;
    margin-top: 0.125rem;
    font-weight: 600;
    color: var(--text);
  }

  .fee-payout-line {
    display: flex;
    justify-content: space-between;
    border-top: 1px dashed var(--border);
    padding-top: 0.375rem;
    margin-top: 0.125rem;
    font-weight: 600;
    color: var(--success);
    font-variant-numeric: tabular-nums;
  }

  .fee-payout-value {
    color: var(--success);
  }

  .stripe-connected-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin-left: 1.5rem;
    padding: 0.25rem 0.625rem;
    background: color-mix(in srgb, var(--success) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--success) 20%, var(--border));
    border-radius: 9999px;
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--success);
  }

  /* ── Crypto recipient prompt ── */
  .crypto-recipient-card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem 0.875rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
  }

  .crypto-recipient-card--missing {
    border-color: color-mix(in srgb, var(--accent, #d97706) 35%, var(--border));
    background: color-mix(in srgb, var(--accent, #d97706) 5%, var(--bg-surface));
  }

  .crypto-recipient-header {
    display: flex;
    flex-direction: column;
    gap: 0.1875rem;
  }

  .crypto-recipient-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text);
  }

  .crypto-recipient-sub {
    font-size: 0.75rem;
    color: var(--text-muted);
    line-height: 1.4;
  }

  .crypto-recipient-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.4375rem 0.625rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .crypto-recipient-addr {
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text);
  }

  .crypto-recipient-btn-link {
    font-size: 0.75rem;
    color: var(--accent-text);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
  }

  .crypto-recipient-btn-link:hover {
    text-decoration: underline;
  }

  .crypto-recipient-btn {
    align-self: flex-start;
    padding: 0.5rem 0.875rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: #fff;
    background: var(--accent);
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background var(--transition);
  }

  .crypto-recipient-btn:hover {
    background: var(--accent-hover);
  }

  .crypto-recipient-warn {
    margin: 0;
    font-size: 0.6875rem;
    color: var(--accent-text, #d97706);
    font-style: italic;
  }
</style>
