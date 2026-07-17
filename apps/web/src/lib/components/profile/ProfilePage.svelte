<script lang="ts">
  import type { UserProfile, EventDirectoryEntry, LikeSubject } from "@woco/shared";
  import { SubjectType, profileLikeSubject } from "@woco/shared";
  import { getProfile, updateProfile, uploadAvatar } from "../../api/profiles.js";
  import { gate } from "../../attendee/gate/gate.svelte.js";
  import { isTicketRequired } from "../../api/attendee-gate.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { navigate } from "../../router/router.svelte.js";
  import { setExternalEventApi, setEventFeedSigner } from "../../api/event-api-registry.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { authPost, authGet } from "../../api/client.js";
  import { getFollowing, getTrending } from "../../api/likes.js";
  import { rememberLabel, nameForSubject } from "../../likes/label-cache.js";
  import type { TrendingSubject } from "@woco/shared";
  import UserAvatar from "./UserAvatar.svelte";
  import ReferralShareCard from "../campaign/ReferralShareCard.svelte";
  import CohortStamp from "../campaign/CohortStamp.svelte";
  import { getBadge } from "../../api/campaign.js";
  import type { BadgeRecord } from "@woco/shared";
  import WalletTab from "./WalletTab.svelte";
  import SubENSPicker from "../../creator/builder/SubENSPicker.svelte";
  import LikeButton from "../likes/LikeButton.svelte";
  import SpendingWallet from "../../attendee/shop/SpendingWallet.svelte";
  import EventCard from "../../attendee/events/EventCard.svelte";
  import { getEventsByCreator } from "../../api/events.js";
  import { isPastEvent } from "../../utils/events.js";
  import { onMount, onDestroy } from "svelte";

  type ProfileTab = "profile" | "wallet" | "events" | "following";

  interface Props {
    address?: string;
  }

  let { address: propAddress }: Props = $props();

  const viewAddress = $derived(propAddress?.toLowerCase() || auth.parent?.toLowerCase() || "");
  const isOwner = $derived(
    auth.isConnected && !!viewAddress && auth.parent?.toLowerCase() === viewAddress,
  );

  let profile = $state<UserProfile | null>(null);
  let loading = $state(true);
  let saving = $state(false);

  // Cohort badge (public read, one tiny GET keyed on the viewed address).
  let badge = $state<BadgeRecord | null>(null);
  $effect(() => {
    badge = null;
    if (!viewAddress) return;
    getBadge(viewAddress as `0x${string}`).then((resp) => {
      if (resp.ok) badge = resp.data ?? null;
    }).catch(() => {});
  });
  let saveError = $state('');
  let ensBindError = $state('');
  let uploadingAvatar = $state(false);
  let avatarPreviewUrl = $state<string | null>(null);
  // A picked-but-not-yet-saved avatar (resized data URL). Staged on file-select,
  // uploaded to Swarm only when the user clicks Save — like the text fields.
  let pendingAvatarDataUrl = $state<string | null>(null);
  let events = $state<EventDirectoryEntry[]>([]);
  let eventsLoaded = $state(false);
  let eventsLoading = $state(false);
  type EventsSubTab = "upcoming" | "past";
  let eventsSubTab = $state<EventsSubTab>("upcoming");
  // Reactive clock — drives the upcoming/past split without any server involvement
  // (same pattern as Home.svelte's discovery tabs).
  let eventsNow = $state(Date.now());
  let eventsClockTimer: ReturnType<typeof setInterval>;
  let following = $state<LikeSubject[]>([]);
  let followingLoaded = $state(false);
  let followingLoading = $state(false);
  let trending = $state<TrendingSubject[]>([]);
  let activeTab = $state<ProfileTab>("profile");
  let addressCopied = $state(false);
  let revokingAll = $state(false);
  let revokeSuccess = $state(false);

  // Edit form
  let editName = $state("");
  let editBio = $state("");
  let editWebsite = $state("");
  let editTwitter = $state("");
  let editFarcaster = $state("");
  let formDirty = $state(false);

  let fileInput: HTMLInputElement | undefined = $state(undefined);

  const displayName = $derived(
    profile?.displayName || `${viewAddress.slice(0, 6)}...${viewAddress.slice(-4)}`,
  );

  const shortAddr = $derived(
    viewAddress ? `${viewAddress.slice(0, 6)}...${viewAddress.slice(-4)}` : "",
  );

  const authKindLabel: Record<string, string> = {
    web3: "Web3 Wallet",
    passkey: "Passkey",
    web3auth: "Email / Social Login",
    coinbase: "Coinbase Smart Wallet",
  };

  const authKindColor: Record<string, string> = {
    web3: "#C7F23A",
    passkey: "#22c55e",
    web3auth: "#38bdf8",
    coinbase: "#2563eb",
  };

  function bannerGradient(addr: string): string {
    const hex = addr.replace("0x", "").slice(0, 16);
    const h1 = parseInt(hex.slice(0, 4), 16) % 360;
    const h2 = (h1 + 55 + (parseInt(hex.slice(4, 8), 16) % 90)) % 360;
    const h3 = (h2 + 40 + (parseInt(hex.slice(8, 12), 16) % 70)) % 360;
    return `linear-gradient(135deg, hsl(${h1},45%,15%) 0%, hsl(${h2},55%,11%) 55%, hsl(${h3},38%,8%) 100%)`;
  }

  function initForm() {
    editName = profile?.displayName ?? "";
    editBio = profile?.bio ?? "";
    editWebsite = profile?.website ?? "";
    editTwitter = profile?.twitterHandle ?? "";
    editFarcaster = profile?.farcasterHandle ?? "";
    formDirty = false;
  }

  // Re-sync the form from a freshly LOADED profile, but never while the user is
  // mid-edit (formDirty) — otherwise staging an avatar (which touches `profile`)
  // would wipe a name they've typed but not yet saved.
  $effect(() => {
    if (profile && !formDirty) initForm();
  });

  // Attendee gate — profiles unlock with a ticket (organisers pass automatically).
  // Silent status check once the session exists; refresh() dedups in-flight calls.
  $effect(() => {
    if (isOwner && auth.hasSession && !gate.status) void gate.refresh();
  });

  const needsUnlock = $derived(isOwner && gate.status !== null && !gate.status.gated);

  /**
   * True when saving may proceed. Blocks only on a POSITIVE "not gated" —
   * unknown status (server unreachable) fails open: the client-signed profile
   * write must not hard-depend on the server, and the server still enforces
   * the gate on its own endpoints.
   */
  async function ensureUnlocked(): Promise<boolean> {
    const status = gate.status ?? (await gate.refresh());
    if (!status || status.gated) return true;
    return gate.request();
  }

  async function saveProfile() {
    if ((!formDirty && !pendingAvatarDataUrl) || saving) return;
    saving = true;
    saveError = '';
    try {
      const ok = await auth.ensureSession();
      if (!ok) { saveError = "Sign-in was cancelled — your changes were not saved."; return; }
      if (!(await ensureUnlocked())) {
        saveError = "Link a ticket to unlock your profile first.";
        return;
      }
      const prevAvatarRef = profile?.avatarRef;
      let merged: UserProfile | null = profile;

      // Text fields — only write the data feed when the user actually edited them.
      if (formDirty) {
        const updated = await updateProfile({
          displayName: editName || undefined,
          bio: editBio || undefined,
          website: editWebsite || undefined,
          twitterHandle: editTwitter || undefined,
          farcasterHandle: editFarcaster || undefined,
        });
        // updateProfile already cached the fresh profile — don't invalidate, or the
        // next read races feed propagation and blanks it. Carry the avatar forward
        // (the data feed doesn't store avatarRef — it lives in a separate feed).
        if (updated) merged = { ...updated, avatarRef: updated.avatarRef ?? prevAvatarRef };
      }

      // Avatar — upload the STAGED image now (on Save), not on file-select.
      if (pendingAvatarDataUrl) {
        uploadingAvatar = true;
        const avatarRef = await uploadAvatar(pendingAvatarDataUrl);
        merged = merged
          ? { ...merged, avatarRef }
          : { v: 1, address: viewAddress as `0x${string}`, avatarRef, updatedAt: new Date().toISOString() };
      }

      if (merged) profile = merged;
      pendingAvatarDataUrl = null;
      avatarPreviewUrl = null;
      formDirty = false;
    } catch (err) {
      // Surface the failure — a swallowed error here looks like a save that
      // silently didn't stick (the feed-signer setup path can throw or be
      // declined, and the write itself can fail after signing).
      saveError = isTicketRequired(err)
        ? "Link a ticket to unlock your profile first."
        : err instanceof Error ? err.message : "Failed to save profile — please try again.";
      console.error("Failed to save profile:", err);
    } finally {
      uploadingAvatar = false;
      saving = false;
    }
  }

  // The picker mints `{label}.woco.eth` on-chain before firing this, so the
  // server's ownership check passes. Binding it to the profile makes the
  // profile a followable like-subject (its namehash — see profileLikeSubject).
  async function handleSubEnsClaim(label: string) {
    ensBindError = '';
    try {
      const updated = await updateProfile({ subEnsLabel: label });
      if (updated) {
        profile = updated;
        // updateProfile already wrote the fresh profile to cache — don't
        // invalidate here or the next Swarm read races against feed propagation.
      }
    } catch (err) {
      if (isTicketRequired(err)) {
        const unlocked = await gate.request();
        if (unlocked) return handleSubEnsClaim(label);
        ensBindError = 'Link a ticket to unlock your account first';
        return;
      }
      const msg = err instanceof Error ? err.message : 'Failed to save name to profile';
      ensBindError = msg;
      console.error("Failed to bind sub-ENS to profile:", err);
    }
  }

  function triggerAvatarUpload() { fileInput?.click(); }

  async function handleAvatarFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;

    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      // STAGE only — show the preview and hold the resized image; it's uploaded to
      // Swarm when the user clicks Save (never on file-select). Does NOT touch
      // `profile`, so it can't wipe a name the user is typing.
      const resized = await resizeImage(dataUrl, 400);
      avatarPreviewUrl = resized;
      pendingAvatarDataUrl = resized;
    } catch (err) {
      console.error("Avatar staging failed:", err);
    } finally {
      input.value = "";
    }
  }

  function resizeImage(dataUrl: string, maxSize: number): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let w = img.width, h = img.height;
        if (w > maxSize || h > maxSize) {
          const ratio = Math.min(maxSize / w, maxSize / h);
          w = Math.round(w * ratio); h = Math.round(h * ratio);
        }
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = dataUrl;
    });
  }

  async function copyAddress() {
    if (!viewAddress) return;
    await navigator.clipboard.writeText(viewAddress);
    addressCopied = true;
    setTimeout(() => { addressCopied = false; }, 2000);
  }

  async function revokeAllSessions() {
    if (revokingAll) return;
    revokingAll = true;
    try {
      await authPost("/api/auth/revoke-all", {});
      revokeSuccess = true;
      setTimeout(() => { revokeSuccess = false; }, 3000);
    } catch (err) {
      console.error("Revoke sessions failed:", err);
    } finally {
      revokingAll = false;
    }
  }

  async function loadProfile() {
    if (!viewAddress) { loading = false; return; }
    try { profile = await getProfile(viewAddress); rememberLabel(profile?.subEnsLabel); }
    catch { /* no profile yet */ }
    finally { loading = false; }
  }

  async function loadEvents() {
    if (eventsLoaded || eventsLoading) return;
    eventsLoading = true;
    try {
      if (isOwner) {
        // Fast path: per-creator Swarm index, no global scan
        const resp = await authGet<EventDirectoryEntry[]>("/api/events/mine");
        if (resp.ok && resp.data) events = resp.data;
      } else {
        // Public profile: the organiser's full catalogue (incl. past events),
        // straight from their per-creator index — no global directory scan.
        events = await getEventsByCreator(viewAddress);
      }
    } catch { /* silent */ }
    finally { eventsLoading = false; eventsLoaded = true; }
  }

  // Client-side split — single source of truth, no extra network calls.
  const upcomingEvents = $derived(
    events.filter(e => !isPastEvent(e, eventsNow))
      .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime()),
  );
  const pastEvents = $derived(
    events.filter(e => isPastEvent(e, eventsNow))
      .sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime()),
  );

  function openEvent(event: EventDirectoryEntry) {
    if (event.apiUrl) setExternalEventApi(event.eventId, event.apiUrl);
    setEventFeedSigner(event.eventId, event.creatorFeedSigner);
    navigate(`/event/${event.eventId}`);
  }

  async function loadFollowing() {
    if (followingLoaded || followingLoading || !viewAddress) return;
    followingLoading = true;
    try {
      const [f, t] = await Promise.all([
        getFollowing(viewAddress),
        getTrending(undefined, 10),
      ]);
      if (f) following = f;
      if (t) trending = t;
    } catch { /* silent */ }
    finally { followingLoading = false; followingLoaded = true; }
  }

  function switchTab(tab: ProfileTab) {
    activeTab = tab;
    if (tab === "events" && !eventsLoaded) loadEvents();
    if (tab === "following" && !followingLoaded) loadFollowing();
  }

  // Reset on address/auth change. Keyed on isConnected too, not just the address:
  // the URL bakes in a static address (`/profile/0x...`), so signing out while
  // parked on your own profile leaves viewAddress unchanged — without the
  // isConnected half of the key this effect would never re-fire and the page
  // would keep showing the previous account's profile after logout.
  let _prevView = "";
  $effect(() => {
    const v = viewAddress;
    const key = `${v}:${auth.isConnected}`;
    if (key === _prevView) return;
    _prevView = key;
    profile = null; events = []; eventsLoaded = false; eventsLoading = false;
    eventsSubTab = "upcoming";
    following = []; followingLoaded = false; followingLoading = false;
    trending = []; avatarPreviewUrl = null; pendingAvatarDataUrl = null;
    if (!v) {
      loading = false;
      if (!auth.isConnected) loginRequest.request().then(ok => { if (!ok) navigate("/"); });
      return;
    }
    loading = true;
    loadProfile();
  });

  // For public (non-owner) profiles, load events immediately once address is known
  $effect(() => {
    if (viewAddress && !isOwner && !eventsLoaded && !eventsLoading) {
      loadEvents();
    }
  });

  onMount(() => {
    eventsClockTimer = setInterval(() => { eventsNow = Date.now(); }, 60_000);
  });
  onDestroy(() => clearInterval(eventsClockTimer));
</script>

<div class="profile-page">

  <!-- ── Banner ─────────────────────────────────────────────── -->
  <div
    class="banner"
    style="background:{viewAddress ? bannerGradient(viewAddress) : 'var(--bg-elevated)'}"
  >
    <div class="banner-noise"></div>
    <div class="banner-vignette"></div>
  </div>

  <!-- ── Identity header ────────────────────────────────────── -->
  <header class="profile-header">
    <!-- Avatar -->
    <div class="avatar-col">
      <div class="avatar-ring">
        {#if avatarPreviewUrl}
          <img src={avatarPreviewUrl} alt="" class="avatar-img" />
        {:else}
          <UserAvatar address={viewAddress} size={88} {profile} />
        {/if}
        {#if isOwner}
          <button
            class="avatar-cam"
            onclick={triggerAvatarUpload}
            disabled={uploadingAvatar}
            title="Change photo"
            aria-label="Change photo"
          >
            {#if uploadingAvatar}
              <span class="spin-xs"></span>
            {:else}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                <circle cx="12" cy="13" r="4"/>
              </svg>
            {/if}
          </button>
          <input
            type="file"
            accept="image/*"
            class="sr-only"
            bind:this={fileInput}
            onchange={handleAvatarFile}
          />
        {/if}
      </div>
    </div>

    <!-- Name + meta -->
    <div class="identity-col">
      {#if loading}
        <div class="skel skel-name"></div>
        <div class="skel skel-addr"></div>
      {:else}
        <div class="name-row">
          <h1 class="display-name">{displayName}</h1>
          {#if badge}
            <span
              class="cohort-mark"
              title={badge.epoch === 0 ? "Early adopter — cohort attested on-chain" : `Cohort ${badge.epoch} — attested on-chain`}
            >
              <CohortStamp epoch={badge.epoch} size={36} />
            </span>
          {/if}
          {#if isOwner && auth.kind}
            <span
              class="kind-badge"
              style="--dot:{authKindColor[auth.kind] ?? 'var(--text-muted)'}"
            >{authKindLabel[auth.kind] ?? auth.kind}</span>
          {/if}
          {#if !isOwner && profile?.subEnsLabel}
            <LikeButton subject={profileLikeSubject(profile.subEnsLabel)} variant="follow" />
          {/if}
        </div>

        {#if profile?.subEnsLabel}
          <span class="ens-chip" title="{profile.subEnsLabel}.woco.eth — on-chain identity">
            <svg width="11" height="11" viewBox="0 0 15 15" fill="none" aria-hidden="true">
              <path d="M7.5 1L9.5 5.5H14.5L10.5 8.5L12 13.5L7.5 10.5L3 13.5L4.5 8.5L0.5 5.5H5.5L7.5 1Z"
                    fill="var(--accent)" opacity="0.14" stroke="var(--accent)" stroke-width="1.1" stroke-linejoin="round"/>
            </svg>
            {profile.subEnsLabel}.woco.eth
          </span>
        {/if}

        <button class="addr-btn" onclick={copyAddress} title={viewAddress}>
          <span class="addr-text">{shortAddr}</span>
          {#if addressCopied}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>
          {:else}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          {/if}
        </button>

        {#if profile?.bio}
          <p class="header-bio">{profile.bio}</p>
        {/if}

        <div class="header-links">
          {#if profile?.website}
            <a href={profile.website} target="_blank" rel="noopener" class="hlink">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
              {profile.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
            </a>
          {/if}
          {#if profile?.twitterHandle}
            <a href="https://x.com/{profile.twitterHandle.replace('@','')}" target="_blank" rel="noopener" class="hlink">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
              {profile.twitterHandle}
            </a>
          {/if}
          {#if profile?.farcasterHandle}
            <a href="https://warpcast.com/{profile.farcasterHandle.replace('@','')}" target="_blank" rel="noopener" class="hlink">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5.24 3h13.52l1.74 5.22h.9V19.8c0 .66-.54 1.2-1.2 1.2h-.6c-.66 0-1.2-.54-1.2-1.2V12c0-1.32-1.08-2.4-2.4-2.4h-4c-1.32 0-2.4 1.08-2.4 2.4v7.8c0 .66-.54 1.2-1.2 1.2h-.6c-.66 0-1.2-.54-1.2-1.2V8.22h.9L5.24 3z"/></svg>
              {profile.farcasterHandle}
            </a>
          {/if}
        </div>
      {/if}
    </div>
  </header>

  <!-- ── Events log sub-tabs (segmented control — nested one level under the
       main tab-nav, so it reads as a lighter secondary control) ─────────── -->
  {#snippet eventsLogToggle()}
    <div class="log-toggle" role="tablist" aria-label="Events log">
      <button
        type="button"
        class="log-toggle-btn"
        class:log-toggle-active={eventsSubTab === "upcoming"}
        onclick={() => eventsSubTab = "upcoming"}
        role="tab"
        aria-selected={eventsSubTab === "upcoming"}
      >
        Upcoming
        {#if upcomingEvents.length > 0}<span class="log-toggle-count">{upcomingEvents.length}</span>{/if}
      </button>
      <button
        type="button"
        class="log-toggle-btn"
        class:log-toggle-active={eventsSubTab === "past"}
        onclick={() => eventsSubTab = "past"}
        role="tab"
        aria-selected={eventsSubTab === "past"}
      >
        Past
        {#if pastEvents.length > 0}<span class="log-toggle-count">{pastEvents.length}</span>{/if}
      </button>
    </div>
  {/snippet}

  {#snippet eventsLogGrid(list, emptyText)}
    {#if list.length === 0}
      <div class="events-empty events-empty--nested">
        <p class="empty-sub">{emptyText}</p>
      </div>
    {:else}
      <div class="events-grid">
        {#each list as event (event.eventId)}
          <EventCard {event} onclick={() => openEvent(event)} />
        {/each}
      </div>
    {/if}
  {/snippet}

  <!-- ── Tabs (owner only) ──────────────────────────────────── -->
  {#if isOwner}
    <nav class="tab-nav" role="tablist">
      <button
        class="tab-btn"
        class:tab-active={activeTab === "profile"}
        onclick={() => switchTab("profile")}
        role="tab"
        aria-selected={activeTab === "profile"}
      >Profile</button>
      <button
        class="tab-btn"
        class:tab-active={activeTab === "wallet"}
        onclick={() => switchTab("wallet")}
        role="tab"
        aria-selected={activeTab === "wallet"}
      >Wallet</button>
      <button
        class="tab-btn"
        class:tab-active={activeTab === "events"}
        onclick={() => switchTab("events")}
        role="tab"
        aria-selected={activeTab === "events"}
      >Events</button>
      <button
        class="tab-btn"
        class:tab-active={activeTab === "following"}
        onclick={() => switchTab("following")}
        role="tab"
        aria-selected={activeTab === "following"}
      >Following</button>
    </nav>
  {/if}

  <!-- ── Tab bodies ─────────────────────────────────────────── -->
  {#if isOwner}

    {#if activeTab === "profile"}
      <div class="tab-body">

        {#if needsUnlock}
          <!-- Attendee gate: profile features unlock with a purchased ticket -->
          <section class="settings-card unlock-card">
            <div class="unlock-row">
              <div class="unlock-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M15 5v2M15 11v2M15 17v2M5 5h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4V7a2 2 0 0 1 2-2z"/>
                </svg>
              </div>
              <div class="unlock-text">
                <p class="unlock-title">Unlock your account with a ticket</p>
                <p class="unlock-sub">
                  Your profile, name and follows unlock once you link a ticket —
                  use the link in your purchase email, or a ticket claimed with
                  this account.
                </p>
              </div>
            </div>
            <button class="save-btn" onclick={() => gate.request()}>Link a ticket</button>
          </section>
        {/if}

        <ReferralShareCard />

        <!-- Edit form -->
        <section class="settings-card">
          <h2 class="card-title">Public profile</h2>

          <div class="field-group">
            <label class="field-label" for="f-name">Display name</label>
            <input
              id="f-name"
              class="field-input"
              type="text"
              bind:value={editName}
              oninput={() => formDirty = true}
              placeholder="Your name"
              maxlength="50"
            />
          </div>

          <div class="field-group">
            <label class="field-label" for="f-bio">Bio</label>
            <textarea
              id="f-bio"
              class="field-input field-textarea"
              bind:value={editBio}
              oninput={() => formDirty = true}
              placeholder="Tell people about yourself"
              maxlength="280"
              rows="3"
            ></textarea>
            <span class="char-count">{editBio.length}/280</span>
          </div>

          <div class="field-group">
            <label class="field-label" for="f-website">Website</label>
            <input
              id="f-website"
              class="field-input"
              type="url"
              bind:value={editWebsite}
              oninput={() => formDirty = true}
              placeholder="https://yoursite.com"
            />
          </div>

          <div class="field-row">
            <div class="field-group">
              <label class="field-label" for="f-twitter">X / Twitter</label>
              <input
                id="f-twitter"
                class="field-input"
                type="text"
                bind:value={editTwitter}
                oninput={() => formDirty = true}
                placeholder="@handle"
              />
            </div>
            <div class="field-group">
              <label class="field-label" for="f-farcaster">Farcaster</label>
              <input
                id="f-farcaster"
                class="field-input"
                type="text"
                bind:value={editFarcaster}
                oninput={() => formDirty = true}
                placeholder="@handle"
              />
            </div>
          </div>

          <button
            class="save-btn"
            onclick={saveProfile}
            disabled={(!formDirty && !pendingAvatarDataUrl) || saving}
          >
            {#if saving}
              <span class="spin-xs"></span> Saving...
            {:else}
              Save changes
            {/if}
          </button>
          {#if saveError}
            <p class="save-error">{saveError}</p>
          {/if}
        </section>

        <!-- Web3 identity (sub-ENS) — claiming a name makes this profile a
             followable on-chain subject. -->
        <section class="settings-card">
          <h2 class="card-title">Web3 identity</h2>
          <p class="card-hint">
            Claim a permanent <code>.woco.eth</code> name for your profile. People
            can follow it on-chain, and it doubles as your payment address.
          </p>
          <SubENSPicker
            claimedLabel={profile?.subEnsLabel}
            onclaim={handleSubEnsClaim}
            singleName={true}
          />
          {#if ensBindError}
            <p class="ens-bind-error">{ensBindError} — name is registered on-chain, try again to link it to your profile.</p>
          {/if}
        </section>

        <!-- Account info -->
        <section class="settings-card">
          <h2 class="card-title">Account</h2>

          <div class="info-row">
            <span class="info-label">Sign-in method</span>
            <span class="info-value">
              <span
                class="kind-dot"
                style="background:{authKindColor[auth.kind ?? ''] ?? 'var(--text-muted)'}"
              ></span>
              {authKindLabel[auth.kind ?? ""] ?? "Unknown"}
            </span>
          </div>

          <div class="info-row">
            <span class="info-label">Address</span>
            <button class="addr-copy-btn" onclick={copyAddress} title={viewAddress}>
              <span class="mono">{shortAddr}</span>
              {#if addressCopied}
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>
                <span class="copy-label copy-label--done">Copied</span>
              {:else}
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <span class="copy-label">Copy</span>
              {/if}
            </button>
          </div>

          {#if profile?.updatedAt}
            <div class="info-row">
              <span class="info-label">Last updated</span>
              <span class="info-value mono-sm">
                {new Date(profile.updatedAt).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" })}
              </span>
            </div>
          {/if}
        </section>

        <!-- Session security -->
        <section class="settings-card settings-card--danger">
          <h2 class="card-title">Session security</h2>
          <p class="card-hint">
            Sign out all active sessions across every device and browser.
            You'll need to reconnect your wallet next time.
          </p>
          <div class="danger-row">
            <div class="session-status">
              <span class="session-dot"></span>
              Session active
            </div>
            <button
              class="revoke-btn"
              onclick={revokeAllSessions}
              disabled={revokingAll}
            >
              {#if revokingAll}
                <span class="spin-xs"></span> Signing out...
              {:else if revokeSuccess}
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>
                Done
              {:else}
                Sign out everywhere
              {/if}
            </button>
          </div>
        </section>

      </div>
    {/if}

    {#if activeTab === "wallet"}
      <div class="tab-body">
        {#if auth.kind === "passkey"}
          <SpendingWallet />
        {/if}
        <WalletTab />
      </div>
    {/if}

    {#if activeTab === "events"}
      <div class="tab-body">
        {#if eventsLoading}
          <div class="events-loading">
            <span class="spin-md"></span>
            <span>Loading your events…</span>
          </div>
        {:else if events.length === 0}
          <div class="events-empty">
            <div class="empty-icon">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
                <line x1="3" y1="10" x2="21" y2="10"/>
              </svg>
            </div>
            <p class="empty-title">No events yet</p>
            <p class="empty-sub">Events you create will appear here.</p>
            <button class="empty-cta" onclick={() => navigate("/creator")}>
              Create your first event
            </button>
          </div>
        {:else}
          {@render eventsLogToggle()}
          {#if eventsSubTab === "upcoming"}
            {@render eventsLogGrid(upcomingEvents, "Nothing upcoming — anything you publish next lands here.")}
          {:else}
            {@render eventsLogGrid(pastEvents, "Nothing in the past yet.")}
          {/if}
        {/if}
      </div>
    {/if}

    {#if activeTab === "following"}
      <div class="tab-body">
        {#if followingLoading}
          <div class="events-loading">
            <span class="spin-md"></span>
            <span>Loading…</span>
          </div>
        {:else}
          {@const followedEvents = following.filter(s => s.type === SubjectType.Event)}
          {@const followedProfiles = following.filter(s => s.type === SubjectType.Profile)}

          {#if following.length === 0}
            <div class="events-empty">
              <div class="empty-icon">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 21L3.5 12.5C1.5 10.5 1.5 7.2 3.5 5.2C5.5 3.2 8.8 3.2 10.8 5.2L12 6.4L13.2 5.2C15.2 3.2 18.5 3.2 20.5 5.2C22.5 7.2 22.5 10.5 20.5 12.5L12 21Z"/>
                </svg>
              </div>
              <p class="empty-title">Nothing liked yet</p>
              <p class="empty-sub">Like events to build your on-chain social graph.</p>
            </div>
          {:else}
            {#if followedEvents.length > 0}
              <div class="follow-section">
                <h3 class="follow-heading">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                    <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
                    <line x1="3" y1="10" x2="21" y2="10"/>
                  </svg>
                  Events <span class="follow-count">{followedEvents.length}</span>
                </h3>
                <div class="follow-list">
                  {#each followedEvents as s}
                    <div class="follow-item">
                      <span class="follow-type-dot ev-dot"></span>
                      <a
                        class="follow-id"
                        href="https://sepolia.arbiscan.io/address/{s.id}"
                        target="_blank"
                        rel="noopener"
                        title={s.id}
                      >{s.id.slice(0, 10)}…{s.id.slice(-8)}</a>
                    </div>
                  {/each}
                </div>
              </div>
            {/if}

            {#if followedProfiles.length > 0}
              <div class="follow-section">
                <h3 class="follow-heading">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                    <circle cx="12" cy="7" r="4"/>
                  </svg>
                  Profiles <span class="follow-count">{followedProfiles.length}</span>
                </h3>
                <div class="follow-list">
                  {#each followedProfiles as s}
                    {@const name = nameForSubject(s.id)}
                    <div class="follow-item">
                      <span class="follow-type-dot pr-dot"></span>
                      {#if name}
                        <span class="follow-name" title={s.id}>{name}</span>
                      {:else}
                        <span class="follow-id" title={s.id}>{s.id.slice(0, 10)}…{s.id.slice(-8)}</span>
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
            {/if}
          {/if}

          {#if followingLoaded && trending.length > 0}
            <div class="follow-section trending-section">
              <h3 class="follow-heading">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
                  <polyline points="16 7 22 7 22 13"/>
                </svg>
                Trending
              </h3>
              <div class="trending-list">
                {#each trending as t, i}
                  {@const tName = t.subjectType === SubjectType.Profile ? nameForSubject(t.subject) : null}
                  <div class="trending-row">
                    <span class="trending-rank">#{i + 1}</span>
                    <span class="trending-type-dot" class:ev-dot={t.subjectType === SubjectType.Event} class:pr-dot={t.subjectType === SubjectType.Profile}></span>
                    <span class="trending-label">{t.subjectType === SubjectType.Event ? "Event" : "Profile"}</span>
                    {#if tName}
                      <span class="trending-name" title={t.subject}>{tName}</span>
                    {:else}
                      <span class="trending-id" title={t.subject}>{t.subject.slice(0, 8)}…{t.subject.slice(-6)}</span>
                    {/if}
                    <span class="trending-count">
                      <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                        <path d="M12 21L3.5 12.5C1.5 10.5 1.5 7.2 3.5 5.2C5.5 3.2 8.8 3.2 10.8 5.2L12 6.4L13.2 5.2C15.2 3.2 18.5 3.2 20.5 5.2C22.5 7.2 22.5 10.5 20.5 12.5L12 21Z"/>
                      </svg>
                      {t.count}
                    </span>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        {/if}
      </div>
    {/if}

  {:else}
    <!-- Non-owner: organiser's public events log -->
    <div class="tab-body">
      {#if !eventsLoaded}
        <div class="events-loading">
          <span class="spin-md"></span>
          <span>Loading events…</span>
        </div>
      {:else if events.length === 0}
        <div class="events-empty">
          <div class="empty-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
              <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
              <line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
          </div>
          <p class="empty-title">No events yet</p>
          <p class="empty-sub">Events from this organiser will appear here.</p>
        </div>
      {:else}
        <h2 class="public-events-heading">Events</h2>
        {@render eventsLogToggle()}
        {#if eventsSubTab === "upcoming"}
          {@render eventsLogGrid(upcomingEvents, "No upcoming events right now.")}
        {:else}
          {@render eventsLogGrid(pastEvents, "No past events yet — this organiser's history will build up here.")}
        {/if}
      {/if}
    </div>
  {/if}

</div>

<style>
  /* ── Page shell ──────────────────────────────────────────── */
  .profile-page {
    max-width: 640px;
    margin: -0.25rem auto 3rem;
  }

  /* ── Banner ──────────────────────────────────────────────── */
  .banner {
    height: 160px;
    border-radius: var(--radius-md);
    position: relative;
    overflow: hidden;
    margin-bottom: -56px;
  }

  .banner-noise {
    position: absolute;
    inset: 0;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.06'/%3E%3C/svg%3E");
    opacity: 0.5;
  }

  .banner-vignette {
    position: absolute;
    inset: 0;
    background: linear-gradient(to bottom, transparent 40%, rgba(0,0,0,0.35) 100%);
  }

  /* ── Profile header ──────────────────────────────────────── */
  .profile-header {
    position: relative;
    display: flex;
    align-items: flex-end;
    gap: 1.25rem;
    padding: 0 0.5rem 1.25rem;
  }

  /* Avatar col */
  .avatar-col {
    flex-shrink: 0;
  }

  .avatar-ring {
    position: relative;
    display: inline-block;
    border-radius: 50%;
    border: 3px solid var(--bg);
    box-shadow: 0 4px 20px rgba(0,0,0,0.4);
  }

  .avatar-img {
    width: 88px;
    height: 88px;
    border-radius: 50%;
    object-fit: cover;
    display: block;
  }

  .avatar-cam {
    position: absolute;
    bottom: 1px;
    right: 1px;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--bg-elevated);
    border: 1.5px solid var(--border);
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background var(--transition), border-color var(--transition), color var(--transition);
  }

  .avatar-cam:hover:not(:disabled) {
    background: var(--accent);
    border-color: var(--accent);
    color: #000;
  }

  .avatar-cam:disabled { opacity: 0.5; cursor: not-allowed; }

  .sr-only {
    position: absolute; width: 1px; height: 1px;
    padding: 0; margin: -1px; overflow: hidden;
    clip: rect(0,0,0,0); white-space: nowrap; border: 0;
  }

  /* Identity col */
  .identity-col {
    flex: 1;
    min-width: 0;
    padding-top: 2.5rem; /* push below avatar overlap zone */
  }

  .name-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    flex-wrap: wrap;
    margin-bottom: 0.25rem;
  }

  .cohort-mark {
    display: inline-flex;
    line-height: 0;
    cursor: help;
  }

  .display-name {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 800;
    color: var(--text);
    letter-spacing: -0.025em;
    line-height: 1.15;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .kind-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    font-size: 0.625rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-muted);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 100px;
    padding: 0.1875rem 0.5625rem 0.1875rem 0.4375rem;
    white-space: nowrap;
  }

  .kind-badge::before {
    content: "";
    display: inline-block;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--dot);
    flex-shrink: 0;
  }

  .ens-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    width: fit-content;
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
    border-radius: 100px;
    padding: 0.1875rem 0.5625rem 0.1875rem 0.4375rem;
    margin-bottom: 0.5rem;
    white-space: nowrap;
  }

  .addr-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.6875rem;
    color: var(--text-muted);
    padding: 0;
    background: none;
    border: none;
    cursor: pointer;
    transition: color var(--transition);
    margin-bottom: 0.5rem;
  }

  .addr-btn:hover { color: var(--accent); }

  .addr-text { letter-spacing: 0.02em; }

  .header-bio {
    margin: 0 0 0.5rem;
    font-size: 0.875rem;
    color: var(--text-secondary);
    line-height: 1.6;
    max-width: 480px;
  }

  .header-links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.625rem;
  }

  .hlink {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    font-size: 0.75rem;
    color: var(--text-muted);
    text-decoration: none;
    transition: color var(--transition);
  }

  .hlink:hover { color: var(--accent); }

  /* Skeletons */
  .skel { background: var(--bg-surface); border-radius: var(--radius-sm); animation: pulse 1.5s ease-in-out infinite; }
  .skel-name { width: 180px; height: 26px; margin-bottom: 0.5rem; }
  .skel-addr { width: 100px; height: 14px; }

  /* ── Tab nav ─────────────────────────────────────────────── */
  .tab-nav {
    display: flex;
    border-bottom: 1px solid var(--border);
    margin: 0 0 0;
    gap: 0;
  }

  .tab-btn {
    padding: 0.75rem 1.375rem;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text-muted);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    cursor: pointer;
    transition: color var(--transition), border-color var(--transition);
    white-space: nowrap;
  }

  .tab-btn:hover { color: var(--text-secondary); }

  .tab-active {
    color: var(--text);
    border-bottom-color: var(--accent);
  }

  /* ── Tab body ────────────────────────────────────────────── */
  .tab-body {
    padding-top: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* ── Settings cards ──────────────────────────────────────── */
  .settings-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1.25rem 1.375rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .settings-card--danger {
    border-color: color-mix(in srgb, var(--error) 20%, var(--border));
  }

  /* Attendee-gate unlock card */
  .unlock-card {
    border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
    background: color-mix(in srgb, var(--accent) 4%, var(--bg-surface));
  }

  .unlock-row {
    display: flex;
    align-items: flex-start;
    gap: 0.875rem;
  }

  .unlock-icon {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    border-radius: var(--radius-sm);
    color: var(--accent);
  }

  .unlock-text {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .unlock-title {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.01em;
  }

  .unlock-sub {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    line-height: 1.55;
  }

  .card-title {
    margin: 0;
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .card-hint {
    margin: -0.25rem 0 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.55;
  }

  .ens-bind-error {
    margin: 0.5rem 0 0;
    font-size: 0.8125rem;
    color: #ef4444;
    line-height: 1.45;
  }

  .save-error {
    margin: 0.5rem 0 0;
    font-size: 0.8125rem;
    color: #ef4444;
    line-height: 1.45;
  }

  /* Form fields */
  .field-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    position: relative;
  }

  .field-label {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .field-input {
    width: 100%;
    padding: 0.5625rem 0.75rem;
    font-size: 0.875rem;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    transition: border-color var(--transition);
    outline: none;
    box-sizing: border-box;
  }

  .field-input:focus {
    border-color: var(--accent);
  }

  .field-textarea {
    resize: vertical;
    min-height: 80px;
    font-family: inherit;
    line-height: 1.5;
  }

  .char-count {
    position: absolute;
    bottom: 0.5rem;
    right: 0.625rem;
    font-size: 0.625rem;
    color: var(--text-muted);
    pointer-events: none;
  }

  .field-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.875rem;
  }

  .save-btn {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5625rem 1.375rem;
    font-size: 0.8125rem;
    font-weight: 700;
    background: var(--accent);
    color: #000;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: opacity var(--transition), transform 0.1s ease;
    letter-spacing: -0.01em;
  }

  .save-btn:hover:not(:disabled) { opacity: 0.88; }
  .save-btn:active:not(:disabled) { transform: scale(0.97); }
  .save-btn:disabled { opacity: 0.35; cursor: not-allowed; }

  /* Info rows */
  .info-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.625rem 0;
    border-bottom: 1px solid var(--border);
  }

  .info-row:last-of-type { border-bottom: none; }

  .info-label {
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }

  .info-value {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text);
  }

  .kind-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .mono {
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.75rem;
  }

  .mono-sm {
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.6875rem;
    color: var(--text-secondary);
    font-weight: 400;
  }

  .addr-copy-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    padding: 0;
    transition: color var(--transition);
    font-size: 0.75rem;
    font-family: "SF Mono", "Fira Code", monospace;
  }

  .addr-copy-btn:hover { color: var(--accent); }

  .copy-label {
    font-family: inherit;
    font-size: 0.6875rem;
    color: var(--text-muted);
    letter-spacing: 0.02em;
  }

  .copy-label--done { color: var(--accent); }

  /* Danger card */
  .danger-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .session-status {
    display: inline-flex;
    align-items: center;
    gap: 0.4375rem;
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }

  .session-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--success);
    box-shadow: 0 0 6px var(--success);
    animation: pulse-dot 2s ease-in-out infinite;
  }

  @keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .revoke-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.4375rem 1rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--error);
    background: color-mix(in srgb, var(--error) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--error) 25%, var(--border));
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background var(--transition), border-color var(--transition);
  }

  .revoke-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--error) 15%, transparent);
    border-color: color-mix(in srgb, var(--error) 40%, var(--border));
  }

  .revoke-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Events grid ─────────────────────────────────────────── */
  .public-events-heading {
    margin: 0 0 1rem;
    font-size: 1rem;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.01em;
  }

  /* Events log — segmented pill control. Deliberately NOT another underlined
     tab row (that's the top-level .tab-nav's job) — a filled pill toggle reads
     as a secondary, nested control and keeps the hierarchy legible. */
  .log-toggle {
    display: inline-flex;
    padding: 0.1875rem;
    gap: 0.125rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 999px;
    margin-bottom: 1rem;
  }

  .log-toggle-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.875rem;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    background: none;
    border: none;
    border-radius: 999px;
    cursor: pointer;
    transition: background var(--transition), color var(--transition);
  }

  .log-toggle-btn:hover { color: var(--text-secondary); }

  .log-toggle-active,
  .log-toggle-active:hover {
    background: var(--accent);
    color: #000;
  }

  .log-toggle-count {
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
  }

  .log-toggle-active .log-toggle-count { opacity: 0.6; }

  .events-empty--nested {
    padding: 2rem 1rem;
    gap: 0;
  }

  .events-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 1rem;
  }

  .events-loading {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 3rem 0;
    justify-content: center;
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  /* Empty state */
  .events-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 3.5rem 1rem;
    gap: 0.625rem;
  }

  .empty-icon {
    width: 64px;
    height: 64px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-muted);
    margin-bottom: 0.5rem;
  }

  .empty-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.01em;
  }

  .empty-sub {
    margin: 0;
    font-size: 0.875rem;
    color: var(--text-muted);
    line-height: 1.5;
  }

  .empty-cta {
    margin-top: 0.75rem;
    padding: 0.5625rem 1.5rem;
    font-size: 0.8125rem;
    font-weight: 700;
    background: var(--accent);
    color: #000;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: opacity var(--transition);
    letter-spacing: -0.01em;
  }

  .empty-cta:hover { opacity: 0.85; }

  /* ── Spinners ────────────────────────────────────────────── */
  .spin-xs {
    display: inline-block;
    width: 11px;
    height: 11px;
    border: 1.5px solid color-mix(in srgb, currentColor 25%, transparent);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.65s linear infinite;
    flex-shrink: 0;
  }

  .spin-md {
    display: inline-block;
    width: 20px;
    height: 20px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.8; } }

  /* ── Following tab ───────────────────────────────────────── */
  .follow-section {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1.125rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .follow-heading {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .follow-count {
    font-family: var(--font-mono, "SF Mono", "Fira Code", monospace);
    color: var(--text-dim);
  }

  .follow-list {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .follow-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem;
    border-radius: var(--radius-sm);
    background: var(--bg);
    border: 1px solid var(--border);
  }

  .follow-type-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .ev-dot { background: var(--accent); }
  .pr-dot { background: var(--text-muted); }

  .follow-id {
    font-family: var(--font-mono, "SF Mono", "Fira Code", monospace);
    font-size: 0.6875rem;
    color: var(--text-secondary);
    text-decoration: none;
    transition: color 0.15s ease;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  a.follow-id:hover { color: var(--accent); }

  .follow-name {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--accent-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .trending-name {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--accent-text);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .trending-section { margin-top: 0.5rem; }

  .trending-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .trending-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg);
  }

  .trending-rank {
    font-family: var(--font-mono, "SF Mono", "Fira Code", monospace);
    font-size: 0.625rem;
    color: var(--text-dim);
    min-width: 1.25rem;
  }

  .trending-type-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .trending-label {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    min-width: 2.5rem;
  }

  .trending-id {
    font-family: var(--font-mono, "SF Mono", "Fira Code", monospace);
    font-size: 0.6875rem;
    color: var(--text-secondary);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .trending-count {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-family: var(--font-mono, "SF Mono", "Fira Code", monospace);
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--accent);
    flex-shrink: 0;
  }

  /* ── Responsive ──────────────────────────────────────────── */
  @media (max-width: 480px) {
    .banner {
      height: 120px;
      border-radius: 0;
      margin-left: -1.25rem;
      margin-right: -1.25rem;
    }

    .profile-header {
      flex-direction: column;
      align-items: flex-start;
      gap: 0;
    }

    .identity-col {
      padding-top: 0.75rem;
    }

    .display-name { font-size: 1.25rem; }

    .field-row { grid-template-columns: 1fr; }

    .tab-btn { padding: 0.625rem 1rem; font-size: 0.8125rem; }
  }
</style>
