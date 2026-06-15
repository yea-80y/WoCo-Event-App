<script lang="ts">
  import type { PaymentConfig, PaymentChainId, Hex0x, PodGate, PodGateGroup } from "@woco/shared";
  import PodGateEditor from "../../components/pod/PodGateEditor.svelte";
  import { CHAIN_NAMES, PLATFORM_FEE_BP, FEATURES, BUYER_FEE_FLOOR_PCT, BUYER_FEE_DEFAULT_PCT } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import StripeConnectModal from "../dashboard/StripeConnectModal.svelte";
  import ConnectWalletModal from "../../components/profile/ConnectWalletModal.svelte";
  import { isWalletAvailable } from "../../wallet/provider.js";
  import { getConnectedAddress } from "../../wallet/connection.js";
  import { onMount } from "svelte";
  import type { ImportTier } from "./ImportUrlPanel.svelte";
  import { getStripeAccountStatus, type StripeAccountStatus } from "../../api/stripe.js";

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
    /** Organiser-set buyer-pays fee % (≥ BUYER_FEE_FLOOR_PCT). Default BUYER_FEE_DEFAULT_PCT. */
    buyerFeePercent: number;
    /** Optional POD-holdings gate — applies to every wave in this tier. */
    gate?: PodGate | PodGateGroup;
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
    gate?: PodGate | PodGateGroup;
  }

  interface Props {
    series: SeriesDraft[];
    /**
     * True when crypto is enabled on at least one tier but no payout wallet has
     * been connected. Bound back to the parent so the publish button can be
     * disabled until the organiser provides a recipient address.
     */
    cryptoRecipientMissing?: boolean;
    /**
     * True when a paid tier has card payments enabled but the organiser's Stripe
     * account isn't verified yet. Bound to the parent so the publish button can
     * block UP FRONT — mirrors the server's live charges_enabled gate so the
     * organiser isn't told to verify only after filling the whole form + clicking
     * publish.
     */
    stripeVerificationMissing?: boolean;
    /**
     * One-shot trigger: when set to a non-empty array, replaces the current
     * tier groups with imported tiers (Skiddle/Fatsoma/Eventbrite). The editor
     * resets this back to `null` after applying, so re-import works.
     */
    importedTiers?: ImportTier[] | null;
  }

  let {
    series = $bindable(),
    cryptoRecipientMissing = $bindable(false),
    stripeVerificationMissing = $bindable(false),
    importedTiers = $bindable(null),
  }: Props = $props();

  let stripeModalOpen = $state(false);
  let stripeModalTierId = $state<string | null>(null);
  let walletModalOpen = $state(false);

  // Real Stripe account status fetched from the server.
  // null = not yet loaded, undefined = not authenticated
  let stripeStatus = $state<StripeAccountStatus | null>(null);
  let stripeStatusLoading = $state(true);

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
    if (!checked) {
      tier.stripeEnabled = false;
      return;
    }
    // Already verified → enable straight away, no modal needed.
    if (stripeStatus?.onboardingComplete) {
      tier.stripeEnabled = true;
      return;
    }
    // Not yet verified → open the connect/verify modal. The checkbox reflects
    // intent immediately; the status row beneath it shows the real account state.
    tier.stripeEnabled = true;
    stripeModalTierId = tier.id;
    stripeModalOpen = true;
  }

  async function handleStripeConnected() {
    if (stripeModalTierId) {
      const tier = tierGroups.find(t => t.id === stripeModalTierId);
      if (tier) tier.stripeEnabled = true;
    }
    stripeModalOpen = false;
    stripeModalTierId = null;
    // Re-fetch the REAL status rather than assuming completion — connecting an
    // account is not the same as finishing identity verification, and claiming
    // "connected" prematurely is exactly the bug we're fixing.
    stripeStatusLoading = true;
    try {
      const resp = await getStripeAccountStatus();
      if (resp.ok) stripeStatus = resp;
    } catch {
      // non-fatal — the publish gate enforces the real check server-side.
    } finally {
      stripeStatusLoading = false;
    }
  }

  function handleStripeModalClose() {
    stripeModalOpen = false;
    stripeModalTierId = null;
  }

  onMount(async () => {
    if (!auth.isConnected) {
      stripeStatusLoading = false;
      return;
    }
    try {
      const resp = await getStripeAccountStatus();
      if (resp.ok) stripeStatus = resp;
    } catch {
      // non-fatal — server gate enforces the real check
    } finally {
      stripeStatusLoading = false;
    }
  });

  function newTier(name = "General Admission"): TierGroup {
    return {
      id: crypto.randomUUID(),
      tierName: name,
      description: "",
      approvalRequired: false,
      isPaid: !FEATURES.freeEventsAllowed,
      price: "",
      currency: "GBP",
      cryptoEnabled: false,
      acceptedChains: [8453] as PaymentChainId[],
      stripeEnabled: true,
      feePassedToCustomer: true,
      buyerFeePercent: BUYER_FEE_DEFAULT_PCT,
      waves: [{
        id: crypto.randomUUID(),
        label: "",
        totalSupply: 10,
        saleStart: "",
        saleEnd: "",
        showSaleWindow: false,
      }],
    };
  }

  let tierGroups = $state<TierGroup[]>([newTier()]);

  // Apply imported tiers (Skiddle/Fatsoma/Eventbrite) exactly once per assignment.
  $effect(() => {
    const tiers = importedTiers;
    if (!tiers || tiers.length === 0) return;
    const VALID = ["GBP", "USD", "EUR"] as const;
    tierGroups = tiers.map((t) => {
      const priceStr = (t.price ?? "").trim();
      const priceNum = parseFloat(priceStr);
      // When free events aren't allowed, importer rows with no/zero price still
      // start as paid (empty price field) so the organiser sets one before publish.
      const importedPaid = !Number.isNaN(priceNum) && priceNum > 0;
      const isPaid = !FEATURES.freeEventsAllowed || importedPaid;
      const ccy = (t.currency ?? "GBP").toUpperCase();
      const currency: "USD" | "GBP" | "EUR" =
        (VALID as readonly string[]).includes(ccy) ? (ccy as "USD" | "GBP" | "EUR") : "GBP";
      return {
        id: crypto.randomUUID(),
        tierName: t.name?.trim() || "General Admission",
        description: "",
        approvalRequired: false,
        isPaid,
        price: importedPaid ? priceStr : "",
        currency,
        cryptoEnabled: false,
        acceptedChains: [8453] as PaymentChainId[],
        stripeEnabled: isPaid,
        feePassedToCustomer: true,
        buyerFeePercent: BUYER_FEE_DEFAULT_PCT,
        waves: [{
          id: crypto.randomUUID(),
          label: "",
          totalSupply: 50,
          saleStart: t.saleStart ?? "",
          saleEnd: t.saleEnd ?? "",
          showSaleWindow: Boolean(t.saleStart || t.saleEnd),
        }],
      };
    });
    importedTiers = null; // consume the trigger so re-imports work
  });

  /** True when at least one tier has crypto enabled — controls whether to show the recipient prompt */
  const anyCryptoEnabled = $derived(tierGroups.some((t) => t.isPaid && t.cryptoEnabled));

  // Push the missing-recipient state up to the parent so PublishButton can disable.
  $effect(() => {
    cryptoRecipientMissing = anyCryptoEnabled && !cryptoRecipientAddress;
  });

  /**
   * True when a paid tier wants card payments but Stripe isn't verified. Only
   * asserted once the real status has loaded — while loading we don't block
   * (avoids a flash-disabled button), and the server's live charges_enabled
   * check is the authoritative backstop either way. Mirrors the server gate so
   * the organiser learns up front, not after filling the whole form.
   */
  const anyStripeUnverified = $derived(
    !stripeStatusLoading &&
    stripeStatus?.onboardingComplete !== true &&
    tierGroups.some((t) => t.isPaid && t.stripeEnabled),
  );
  $effect(() => {
    stripeVerificationMissing = anyStripeUnverified;
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
          ...(tier.gate ? { gate: tier.gate } : {}),
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
            ...(tier.feePassedToCustomer ? { buyerFeePercent: tier.buyerFeePercent } : {}),
          };
        }
        return base;
      })
    );
    console.log("[TicketSeriesEditor] series built:", built.map(s => ({ name: s.name, payment: s.payment })));
    series = built;
  });

  const CURRENCY_SYMBOLS: Record<string, string> = { GBP: "£", USD: "$", EUR: "€" };

  const STRIPE_PERCENT = 0.03;   // 3% of ticket price
  const PLATFORM_PERCENT = PLATFORM_FEE_BP / 10_000; // 1.5%

  function feeBreakdown(price: string, currency: string, passToCustomer: boolean, hasStripe: boolean, hasCrypto: boolean, buyerFeePct: number) {
    const amount = parseFloat(price);
    if (!amount || amount <= 0) return null;
    const sym = CURRENCY_SYMBOLS[currency] ?? "";
    const fmt = (n: number) => `${sym}${n.toFixed(2)}`;
    const stripeFee = hasStripe ? amount * STRIPE_PERCENT : 0;
    const platformFee = amount * PLATFORM_PERCENT;

    if (passToCustomer) {
      const buyerMarkup = amount * (buyerFeePct / 100);
      const cardTotal = amount + buyerMarkup;
      const cryptoTotal = amount + buyerMarkup;
      const payoutCard = hasStripe ? cardTotal - stripeFee - platformFee : 0;
      const payoutCrypto = hasCrypto ? cryptoTotal - platformFee : 0;
      return {
        mode: "pass" as const,
        basePrice: fmt(amount),
        buyerMarkup: fmt(buyerMarkup),
        stripeFee: hasStripe ? fmt(stripeFee) : null,
        platformFeeCard: hasStripe ? fmt(platformFee) : null,
        platformFeeCrypto: hasCrypto ? fmt(platformFee) : null,
        cardTotal: hasStripe ? fmt(cardTotal) : null,
        cryptoTotal: hasCrypto ? fmt(cryptoTotal) : null,
        payoutCard: hasStripe ? fmt(Math.max(0, payoutCard)) : null,
        payoutCrypto: hasCrypto ? fmt(Math.max(0, payoutCrypto)) : null,
      };
    } else {
      const payoutCard = amount - stripeFee - platformFee;
      const payoutCrypto = amount - platformFee;
      return {
        mode: "absorb" as const,
        basePrice: fmt(amount),
        stripeFee: hasStripe ? fmt(stripeFee) : null,
        platformFeeCard: hasStripe ? fmt(platformFee) : null,
        platformFeeCrypto: hasCrypto ? fmt(platformFee) : null,
        cardTotal: null,
        cryptoTotal: null,
        payoutCard: hasStripe ? fmt(Math.max(0, payoutCard)) : null,
        payoutCrypto: hasCrypto ? fmt(Math.max(0, payoutCrypto)) : null,
      };
    }
  }

  function addTier() {
    tierGroups.push(newTier(""));
  }

  /** Snap a buyer-fee % input back to the floor when the user blurs below it. */
  function clampBuyerFee(tier: TierGroup) {
    if (!Number.isFinite(tier.buyerFeePercent) || tier.buyerFeePercent < BUYER_FEE_FLOOR_PCT) {
      tier.buyerFeePercent = BUYER_FEE_FLOOR_PCT;
    }
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
        {#if FEATURES.freeEventsAllowed}
          <label class="approval-toggle">
            <input type="checkbox" bind:checked={tier.isPaid} />
            <span class="approval-label">Paid ticket</span>
            <span class="approval-hint">Set a price for this tier</span>
          </label>
        {/if}

        {#if tier.isPaid}
          <div class="payment-config">
            <div class="payment-row">
              <label class="field payment-price-field">
                <span class="field-label">Price <span class="required">*</span></span>
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

              {#if FEATURES.cryptoPaymentsAllowed}
                <label class="chain-check">
                  <input type="checkbox" bind:checked={tier.cryptoEnabled} />
                  <span>Crypto (ETH/USDC — converted from {tier.currency} at claim time)</span>
                </label>

                {#if tier.cryptoEnabled}
                  <div class="payment-chains" style="margin-left: 1.5rem; margin-top: 0.25rem;">
                    <span class="field-label" style="font-size: 0.6875rem;">Networks</span>
                    <div class="chain-checkboxes">
                      {#each [[8453, "Base"], [10, "Optimism"], [42161, "Arbitrum"], [1, "Ethereum"], [11155111, "Sepolia (testnet)"], [421614, "Arbitrum Sepolia (testnet)"]] as [chainId, name]}
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
              {/if}

              {#if FEATURES.cryptoPaymentsAllowed}
                <label class="chain-check">
                  <input
                    type="checkbox"
                    checked={tier.stripeEnabled}
                    onchange={(e) => handleStripeToggle(tier, (e.target as HTMLInputElement).checked)}
                  />
                  <span>Card payments</span>
                </label>
              {:else}
                <!-- Card-only mode: Stripe is the sole payment rail; surface real
                     account verification state. -->
                <button
                  type="button"
                  class="card-payments-row"
                  onclick={() => handleStripeToggle(tier, true)}
                  disabled={stripeStatus?.onboardingComplete === true}
                >
                  <span class="card-payments-label">
                    <span class="card-payments-title">Card payments</span>
                    <span class="card-payments-sub">Powered by Stripe</span>
                  </span>
                  {#if stripeStatusLoading}
                    <span class="card-payments-status card-payments-status--loading">
                      <span class="stripe-status-spinner"></span>
                      Checking...
                    </span>
                  {:else if stripeStatus?.onboardingComplete}
                    <span class="card-payments-status card-payments-status--ok">
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                        <circle cx="7" cy="7" r="6" fill="var(--success)" opacity="0.15"/>
                        <path d="M4 7.5L6 9.5L10 5" stroke="var(--success)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                      Verified
                    </span>
                  {:else if stripeStatus?.connected}
                    <span class="card-payments-status card-payments-status--warn">
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                        <circle cx="7" cy="7" r="6" stroke="var(--warning)" stroke-width="1.2" fill="none" opacity="0.6"/>
                        <path d="M7 4.5V7.5M7 9.5V10" stroke="var(--warning)" stroke-width="1.3" stroke-linecap="round"/>
                      </svg>
                      Setup incomplete →
                    </span>
                  {:else}
                    <span class="card-payments-status card-payments-status--cta">Connect Stripe →</span>
                  {/if}
                </button>
              {/if}
              {#if FEATURES.cryptoPaymentsAllowed && tier.stripeEnabled}
                <!-- Truthful Stripe status: driven by the real account state
                     (stripeStatus), NOT by the checkbox. Clickable to open the
                     connect/verify modal unless already verified. -->
                <button
                  type="button"
                  class="stripe-verify-row"
                  onclick={() => handleStripeToggle(tier, true)}
                  disabled={stripeStatusLoading || stripeStatus?.onboardingComplete === true}
                >
                  {#if stripeStatusLoading}
                    <span class="card-payments-status card-payments-status--loading">
                      <span class="stripe-status-spinner"></span>
                      Checking Stripe status…
                    </span>
                  {:else if stripeStatus?.onboardingComplete}
                    <span class="card-payments-status card-payments-status--ok">
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                        <circle cx="7" cy="7" r="6" fill="var(--success)" opacity="0.15"/>
                        <path d="M4 7.5L6 9.5L10 5" stroke="var(--success)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                      Stripe connected
                    </span>
                  {:else if stripeStatus?.connected}
                    <span class="card-payments-status card-payments-status--warn">
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                        <circle cx="7" cy="7" r="6" stroke="var(--warning)" stroke-width="1.2" fill="none" opacity="0.6"/>
                        <path d="M7 4.5V7.5M7 9.5V10" stroke="var(--warning)" stroke-width="1.3" stroke-linecap="round"/>
                      </svg>
                      Finish Stripe verification →
                    </span>
                  {:else}
                    <span class="card-payments-status card-payments-status--cta">
                      Connect Stripe to accept cards →
                    </span>
                  {/if}
                </button>
              {/if}
            </div>

            {#if (tier.stripeEnabled || tier.cryptoEnabled) && tier.price && parseFloat(tier.price) > 0}
              {#if FEATURES.cryptoPaymentsAllowed}
                <!-- Fee handling toggle — hidden in card-only mode because the server
                     currently hardcodes the buyer-pays policy for Stripe payments. -->
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

                {#if tier.feePassedToCustomer}
                  <label class="field buyer-fee-field">
                    <span class="field-label">Booking fee % (added to buyer's total)</span>
                    <div class="buyer-fee-input-wrap">
                      <input
                        type="number"
                        min={BUYER_FEE_FLOOR_PCT}
                        step="0.5"
                        bind:value={tier.buyerFeePercent}
                        onblur={() => clampBuyerFee(tier)}
                      />
                      <span class="buyer-fee-suffix">%</span>
                    </div>
                    <span class="approval-hint">
                      Minimum {BUYER_FEE_FLOOR_PCT}% covers card processing (3%) + platform fee (1.5%).
                      Anything above goes to you.
                    </span>
                  </label>
                {/if}
              {:else}
                <p class="booking-fee-note">
                  A {BUYER_FEE_DEFAULT_PCT}% booking fee is added at checkout and covers
                  card processing and the platform fee.
                </p>
              {/if}

              {@const fees = feeBreakdown(tier.price, tier.currency, tier.feePassedToCustomer, tier.stripeEnabled, tier.cryptoEnabled, tier.buyerFeePercent)}
              {#if fees}
                <div class="fee-breakdown">
                  {#if fees.mode === "pass"}
                    <span class="fee-breakdown-title">Per ticket</span>
                    {#if tier.stripeEnabled}
                      <div class="fee-breakdown-col">
                        {#if tier.cryptoEnabled}
                          <span class="fee-col-label">Card</span>
                        {/if}
                        <div class="fee-row"><span>Ticket price</span><span>{fees.basePrice}</span></div>
                        <div class="fee-row fee-deduction"><span>Booking fee ({tier.buyerFeePercent}%)</span><span>+{fees.buyerMarkup}</span></div>
                        <div class="fee-row fee-total"><span>Buyer pays</span><span>{fees.cardTotal}</span></div>
                        <div class="fee-row fee-deduction"><span>Card processing</span><span>−{fees.stripeFee}</span></div>
                        <div class="fee-row fee-deduction"><span>Platform fee</span><span>−{fees.platformFeeCard}</span></div>
                        <div class="fee-row fee-total"><span>You receive</span><span>{fees.payoutCard}</span></div>
                      </div>
                    {/if}
                    {#if tier.cryptoEnabled}
                      <div class="fee-breakdown-col">
                        <span class="fee-col-label">Crypto</span>
                        <div class="fee-row"><span>Ticket price</span><span>{fees.basePrice}</span></div>
                        <div class="fee-row fee-deduction"><span>Booking fee ({tier.buyerFeePercent}%)</span><span>+{fees.buyerMarkup}</span></div>
                        <div class="fee-row fee-total"><span>Buyer pays</span><span>{fees.cryptoTotal}</span></div>
                        <div class="fee-row fee-deduction"><span>Platform fee (1.5%)</span><span>−{fees.platformFeeCrypto}</span></div>
                        <div class="fee-row fee-total"><span>You receive</span><span>{fees.payoutCrypto}</span></div>
                      </div>
                    {/if}
                  {:else}
                    <span class="fee-breakdown-title">Your payout (per ticket)</span>
                    <div class="fee-row"><span>Ticket price</span><span>{fees.basePrice}</span></div>
                    {#if tier.stripeEnabled}
                      <div class="fee-row fee-deduction"><span>Card processing</span><span>−{fees.stripeFee}</span></div>
                      <div class="fee-row fee-deduction"><span>Platform fee</span><span>−{fees.platformFeeCard}</span></div>
                      <div class="fee-row fee-total"><span>You receive (card)</span><span>{fees.payoutCard}</span></div>
                    {/if}
                    {#if tier.cryptoEnabled}
                      <div class="fee-row fee-deduction"><span>Platform fee (1.5%)</span><span>−{fees.platformFeeCrypto}</span></div>
                      <div class="fee-row fee-total"><span>You receive (crypto)</span><span>{fees.payoutCrypto}</span></div>
                    {/if}
                  {/if}
                </div>
              {/if}
            {/if}
          </div>
        {/if}

        <!-- POD-holdings gate (optional) -->
        <PodGateEditor gate={tier.gate} onChange={(g) => { tier.gate = g; }} />

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

  .buyer-fee-field {
    margin-top: 0.25rem;
  }

  .buyer-fee-input-wrap {
    position: relative;
    width: 6rem;
  }

  .buyer-fee-input-wrap input {
    width: 100%;
    padding: 0.375rem 1.4rem 0.375rem 0.5rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.8125rem;
    font-family: inherit;
  }

  .buyer-fee-input-wrap input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .buyer-fee-suffix {
    position: absolute;
    right: 0.5rem;
    top: 50%;
    transform: translateY(-50%);
    font-size: 0.75rem;
    color: var(--text-muted);
    pointer-events: none;
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

  /* ── Card payments row (card-only mode) ── */
  .card-payments-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    width: 100%;
    padding: 0.625rem 0.75rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
    transition: border-color var(--transition), background var(--transition);
  }

  .card-payments-row:hover:not(:disabled) {
    border-color: var(--accent);
  }

  .card-payments-row:disabled {
    cursor: default;
  }

  .card-payments-label {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
  }

  .card-payments-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text);
  }

  .card-payments-sub {
    font-size: 0.6875rem;
    color: var(--text-muted);
  }

  .card-payments-status {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .card-payments-status--ok {
    color: var(--success);
  }

  .card-payments-status--warn {
    color: var(--warning, #f59e0b);
  }

  .card-payments-status--loading {
    color: var(--text-muted);
    gap: 0.4375rem;
  }

  .card-payments-status--cta {
    color: var(--accent-text);
  }

  .stripe-status-spinner {
    width: 10px;
    height: 10px;
    border: 1.5px solid var(--border);
    border-top-color: var(--text-muted);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  /* ── Booking-fee note (card-only mode) ── */
  .booking-fee-note {
    margin: 0;
    padding: 0.5rem 0.625rem;
    background: var(--bg-elevated);
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    color: var(--text-secondary);
    line-height: 1.4;
  }

  /* Truthful Stripe status row (crypto-allowed mode) — a bare button so the
     whole status is clickable to open the connect/verify modal when not yet
     verified; disabled (no pointer) once verified or while loading. */
  .stripe-verify-row {
    display: inline-flex;
    align-items: center;
    margin-left: 1.5rem;
    padding: 0.25rem 0;
    background: none;
    border: none;
    cursor: pointer;
  }

  .stripe-verify-row:disabled {
    cursor: default;
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

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
