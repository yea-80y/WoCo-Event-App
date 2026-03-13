<script lang="ts">
  import type { UserProfile, EventDirectoryEntry } from "@woco/shared";
  import { getProfile, updateProfile, uploadAvatar, invalidateProfileCache } from "../../api/profiles.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { navigate } from "../../router/router.svelte.js";
  import { setExternalEventApi } from "../../api/event-api-registry.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import UserAvatar from "./UserAvatar.svelte";
  import EventCard from "../events/EventCard.svelte";
  import { get } from "../../api/client.js";
  import { onMount } from "svelte";

  interface Props {
    address?: string;
  }

  let { address: propAddress }: Props = $props();

  const BEE_GATEWAY = import.meta.env.VITE_GATEWAY_URL || "https://gateway.woco-net.com";

  // Resolve which address we're viewing
  const viewAddress = $derived(propAddress?.toLowerCase() || auth.parent?.toLowerCase() || "");

  // Is this the current user's own profile?
  const isOwner = $derived(
    auth.isConnected && auth.parent?.toLowerCase() === viewAddress.toLowerCase(),
  );

  let profile = $state<UserProfile | null>(null);
  let loading = $state(true);
  let editing = $state(false);
  let saving = $state(false);
  let uploadingAvatar = $state(false);
  /** Local preview URL shown immediately while the upload is in progress */
  let avatarPreviewUrl = $state<string | null>(null);
  let events = $state<EventDirectoryEntry[]>([]);
  let eventsLoading = $state(true);

  // Edit form state
  let editName = $state("");
  let editBio = $state("");
  let editWebsite = $state("");
  let editTwitter = $state("");
  let editFarcaster = $state("");

  // File input ref
  let fileInput: HTMLInputElement | undefined = $state(undefined);

  const displayName = $derived(
    profile?.displayName || `${viewAddress.slice(0, 6)}...${viewAddress.slice(-4)}`,
  );

  // Deterministic banner gradient from address
  function bannerGradient(addr: string): string {
    const hex = addr.replace("0x", "").slice(0, 16);
    const h1 = parseInt(hex.slice(0, 4), 16) % 360;
    const h2 = (h1 + 50 + (parseInt(hex.slice(4, 8), 16) % 100)) % 360;
    const h3 = (h2 + 30 + (parseInt(hex.slice(8, 12), 16) % 60)) % 360;
    return `linear-gradient(135deg, hsl(${h1}, 40%, 18%) 0%, hsl(${h2}, 50%, 14%) 50%, hsl(${h3}, 35%, 10%) 100%)`;
  }

  function enterEdit() {
    editName = profile?.displayName ?? "";
    editBio = profile?.bio ?? "";
    editWebsite = profile?.website ?? "";
    editTwitter = profile?.twitterHandle ?? "";
    editFarcaster = profile?.farcasterHandle ?? "";
    editing = true;
  }

  function cancelEdit() {
    editing = false;
  }

  async function saveProfile() {
    saving = true;
    try {
      await auth.ensureSession();
      const updated = await updateProfile({
        displayName: editName || undefined,
        bio: editBio || undefined,
        website: editWebsite || undefined,
        twitterHandle: editTwitter || undefined,
        farcasterHandle: editFarcaster || undefined,
      });
      if (updated) {
        profile = updated;
        invalidateProfileCache(viewAddress);
      }
      editing = false;
    } catch (err) {
      console.error("Failed to save profile:", err);
    } finally {
      saving = false;
    }
  }

  function triggerAvatarUpload() {
    fileInput?.click();
  }

  async function handleAvatarFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    // Validate type
    if (!file.type.startsWith("image/")) return;

    // Read as data URL immediately for preview
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    // Show preview instantly before uploading
    avatarPreviewUrl = dataUrl;
    uploadingAvatar = true;

    try {
      await auth.ensureSession();

      // Resize to max 400x400 before uploading
      const resized = await resizeImage(dataUrl, 400);
      const avatarRef = await uploadAvatar(resized);

      // Update local profile state immediately
      if (profile) {
        profile = { ...profile, avatarRef };
      } else {
        profile = {
          v: 1,
          address: viewAddress as `0x${string}`,
          avatarRef,
          updatedAt: new Date().toISOString(),
        };
      }
      invalidateProfileCache(viewAddress);
      avatarPreviewUrl = null; // Swarm URL takes over
    } catch (err) {
      console.error("Failed to upload avatar:", err);
      // Keep preview so user sees what they picked — they can retry
    } finally {
      uploadingAvatar = false;
      input.value = "";
    }
  }

  function resizeImage(dataUrl: string, maxSize: number): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let w = img.width;
        let h = img.height;
        if (w > maxSize || h > maxSize) {
          const ratio = Math.min(maxSize / w, maxSize / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = dataUrl;
    });
  }

  async function loadProfile() {
    if (!viewAddress) {
      loading = false;
      return;
    }
    try {
      profile = await getProfile(viewAddress);
    } catch {
      // Profile doesn't exist yet — that's fine
    } finally {
      loading = false;
    }
  }

  async function loadEvents() {
    if (!viewAddress) {
      eventsLoading = false;
      return;
    }
    try {
      const resp = await get<EventDirectoryEntry[]>("/api/events");
      if (resp.ok && resp.data) {
        events = resp.data.filter(
          (e) => e.creatorAddress.toLowerCase() === viewAddress.toLowerCase(),
        );
      }
    } catch {
      // Silent fail
    } finally {
      eventsLoading = false;
    }
  }

  onMount(() => {
    if (!viewAddress && !auth.isConnected) {
      // Not logged in and no address — prompt login
      loginRequest.request().then((ok) => {
        if (!ok) navigate("/");
      });
      loading = false;
      return;
    }
    loadProfile();
    loadEvents();
  });
</script>

<div class="profile-page">
  <!-- Banner -->
  <div class="banner" style="background:{viewAddress ? bannerGradient(viewAddress) : 'var(--bg-elevated)'}">
    <div class="banner-pattern"></div>
  </div>

  <!-- Profile header -->
  <div class="profile-header">
    <div class="avatar-section">
      <div class="avatar-wrapper">
        {#if avatarPreviewUrl}
          <img src={avatarPreviewUrl} alt="" class="avatar-preview" />
        {:else}
          <UserAvatar
            address={viewAddress}
            size={96}
            profile={profile}
          />
        {/if}
        {#if isOwner}
          <button
            class="avatar-upload-btn"
            onclick={triggerAvatarUpload}
            disabled={uploadingAvatar}
            title="Change photo"
          >
            {#if uploadingAvatar}
              <span class="spinner-small"></span>
            {:else}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                <circle cx="12" cy="13" r="4"/>
              </svg>
            {/if}
          </button>
          <input
            type="file"
            accept="image/*"
            class="hidden-input"
            bind:this={fileInput}
            onchange={handleAvatarFile}
          />
        {/if}
      </div>
    </div>

    <div class="profile-info">
      {#if loading}
        <div class="skeleton-name"></div>
      {:else if editing}
        <!-- Edit form -->
        <div class="edit-form">
          <div class="form-field">
            <label for="edit-name">Display name</label>
            <input id="edit-name" type="text" bind:value={editName} placeholder="Your name" maxlength="50" />
          </div>
          <div class="form-field">
            <label for="edit-bio">Bio</label>
            <textarea id="edit-bio" bind:value={editBio} placeholder="Tell people about yourself" maxlength="280" rows="3"></textarea>
            <span class="char-count">{editBio.length}/280</span>
          </div>
          <div class="form-field">
            <label for="edit-website">Website</label>
            <input id="edit-website" type="url" bind:value={editWebsite} placeholder="https://yoursite.com" />
          </div>
          <div class="form-row">
            <div class="form-field">
              <label for="edit-twitter">X / Twitter</label>
              <input id="edit-twitter" type="text" bind:value={editTwitter} placeholder="@handle" />
            </div>
            <div class="form-field">
              <label for="edit-farcaster">Farcaster</label>
              <input id="edit-farcaster" type="text" bind:value={editFarcaster} placeholder="@handle" />
            </div>
          </div>
          <div class="edit-actions">
            <button class="btn-save" onclick={saveProfile} disabled={saving}>
              {saving ? "Saving..." : "Save profile"}
            </button>
            <button class="btn-cancel" onclick={cancelEdit} disabled={saving}>Cancel</button>
          </div>
        </div>
      {:else}
        <!-- Display mode -->
        <div class="name-row">
          <h1>{displayName}</h1>
          {#if isOwner}
            <button class="btn-edit" onclick={enterEdit}>Edit profile</button>
          {/if}
        </div>

        <p class="profile-address" title={viewAddress}>
          {viewAddress.slice(0, 6)}...{viewAddress.slice(-4)}
        </p>

        {#if profile?.bio}
          <p class="profile-bio">{profile.bio}</p>
        {/if}

        <div class="profile-links">
          {#if profile?.website}
            <a href={profile.website} target="_blank" rel="noopener" class="profile-link">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
              </svg>
              <span>{profile.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>
            </a>
          {/if}
          {#if profile?.twitterHandle}
            <a
              href="https://x.com/{profile.twitterHandle.replace('@', '')}"
              target="_blank"
              rel="noopener"
              class="profile-link"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
              </svg>
              <span>{profile.twitterHandle}</span>
            </a>
          {/if}
          {#if profile?.farcasterHandle}
            <a
              href="https://warpcast.com/{profile.farcasterHandle.replace('@', '')}"
              target="_blank"
              rel="noopener"
              class="profile-link"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M5.24 3h13.52l1.74 5.22h.9V19.8c0 .66-.54 1.2-1.2 1.2h-.6c-.66 0-1.2-.54-1.2-1.2V12c0-1.32-1.08-2.4-2.4-2.4h-4c-1.32 0-2.4 1.08-2.4 2.4v7.8c0 .66-.54 1.2-1.2 1.2h-.6c-.66 0-1.2-.54-1.2-1.2V8.22h.9L5.24 3z"/>
              </svg>
              <span>{profile.farcasterHandle}</span>
            </a>
          {/if}
        </div>

        {#if !profile?.displayName && isOwner}
          <div class="setup-prompt">
            <p>Set up your profile so attendees and organisers know who you are.</p>
            <button class="btn-setup" onclick={enterEdit}>Complete your profile</button>
          </div>
        {/if}
      {/if}
    </div>
  </div>

  <!-- Events section -->
  {#if events.length > 0 || eventsLoading}
    <section class="profile-events">
      <h2>
        {isOwner ? "Your events" : `Events by ${profile?.displayName || displayName}`}
      </h2>
      {#if eventsLoading}
        <p class="status-text">Loading events...</p>
      {:else}
        <div class="event-grid">
          {#each events as event}
            <EventCard {event} onclick={() => {
              if (event.apiUrl) setExternalEventApi(event.eventId, event.apiUrl);
              navigate(`/event/${event.eventId}`);
            }} />
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .profile-page {
    max-width: 640px;
    margin: -0.25rem auto 0;
  }

  /* Banner */
  .banner {
    height: 140px;
    border-radius: var(--radius-md);
    position: relative;
    overflow: hidden;
    margin-bottom: -48px;
  }

  .banner-pattern {
    position: absolute;
    inset: 0;
    background-image:
      radial-gradient(ellipse at 30% 20%, rgba(124, 108, 240, 0.12) 0%, transparent 60%),
      radial-gradient(ellipse at 80% 80%, rgba(255, 255, 255, 0.03) 0%, transparent 50%);
  }

  /* Profile header */
  .profile-header {
    position: relative;
    padding: 0 0.5rem;
  }

  .avatar-section {
    margin-bottom: 0.875rem;
  }

  .avatar-wrapper {
    position: relative;
    display: inline-block;
    border-radius: 50%;
    border: 3px solid var(--bg);
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3);
  }

  .avatar-preview {
    width: 96px;
    height: 96px;
    border-radius: 50%;
    object-fit: cover;
  }

  .avatar-upload-btn {
    position: absolute;
    bottom: 2px;
    right: 2px;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--bg-elevated);
    border: 1.5px solid var(--border);
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all var(--transition);
    z-index: 1;
  }

  .avatar-upload-btn:hover {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }

  .avatar-upload-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .hidden-input {
    position: absolute;
    width: 0;
    height: 0;
    opacity: 0;
    pointer-events: none;
  }

  .spinner-small {
    width: 12px;
    height: 12px;
    border: 2px solid var(--border);
    border-top-color: var(--accent-text);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Profile info */
  .profile-info {
    padding-bottom: 1.5rem;
  }

  .name-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .name-row h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.02em;
    line-height: 1.2;
  }

  .btn-edit {
    padding: 0.3125rem 0.75rem;
    font-size: 0.75rem;
    font-weight: 600;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    transition: all var(--transition);
  }

  .btn-edit:hover {
    border-color: var(--accent);
    color: var(--accent-text);
  }

  .profile-address {
    margin: 0.25rem 0 0;
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .profile-bio {
    margin: 0.75rem 0 0;
    font-size: 0.9375rem;
    color: var(--text-secondary);
    line-height: 1.6;
    max-width: 480px;
  }

  .profile-links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-top: 0.75rem;
  }

  .profile-link {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    font-size: 0.8125rem;
    color: var(--text-muted);
    text-decoration: none;
    transition: color var(--transition);
  }

  .profile-link:hover {
    color: var(--accent-text);
    text-decoration: none;
  }

  .profile-link svg {
    flex-shrink: 0;
    opacity: 0.7;
  }

  .profile-link:hover svg {
    opacity: 1;
  }

  /* Setup prompt */
  .setup-prompt {
    margin-top: 1.25rem;
    padding: 1rem 1.25rem;
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
  }

  .setup-prompt p {
    margin: 0 0 0.75rem;
    font-size: 0.875rem;
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .btn-setup {
    padding: 0.4375rem 1rem;
    font-size: 0.8125rem;
    font-weight: 600;
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius-sm);
    transition: background var(--transition);
  }

  .btn-setup:hover {
    background: var(--accent-hover);
  }

  /* Edit form */
  .edit-form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 440px;
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    position: relative;
  }

  .form-field label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .form-field input,
  .form-field textarea {
    width: 100%;
  }

  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  .char-count {
    position: absolute;
    bottom: 0.5rem;
    right: 0.625rem;
    font-size: 0.6875rem;
    color: var(--text-muted);
    pointer-events: none;
  }

  .edit-actions {
    display: flex;
    gap: 0.625rem;
    padding-top: 0.25rem;
  }

  .btn-save {
    padding: 0.5rem 1.25rem;
    font-size: 0.8125rem;
    font-weight: 600;
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius-sm);
    transition: background var(--transition);
  }

  .btn-save:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .btn-save:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-cancel {
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    font-weight: 500;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    transition: all var(--transition);
  }

  .btn-cancel:hover:not(:disabled) {
    border-color: var(--text-secondary);
    color: var(--text);
  }

  /* Events section */
  .profile-events {
    padding: 1.5rem 0;
    border-top: 1px solid var(--border);
  }

  .profile-events h2 {
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text);
    margin: 0 0 1rem;
  }

  .event-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 1rem;
  }

  .status-text {
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .skeleton-name {
    width: 180px;
    height: 28px;
    background: var(--bg-surface);
    border-radius: var(--radius-sm);
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 0.8; }
  }

  @media (max-width: 480px) {
    .banner {
      height: 110px;
      border-radius: 0;
      margin-left: -1.25rem;
      margin-right: -1.25rem;
    }

    .form-row {
      grid-template-columns: 1fr;
    }
  }
</style>
