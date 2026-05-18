import type { Hex64 } from "../types.js";

// ---------------------------------------------------------------------------
// Site schema — shared between builder UI, server, and deployed site runtime
// ---------------------------------------------------------------------------
//
// A `Site` describes a multi-page website built from templates. The builder UI
// is a typed form over this schema; the deployed site is a Vite bundle of
// Svelte components that read this JSON at runtime. Adding a new template =
// new `templateId` preset (defaults for theme + pages). Adding a new section
// kind = new variant in the `Section` discriminated union.
//
// Persistence:
//   woco/site/config/{siteId}     → Site JSON (this type)
//   woco/site/{siteId}/events     → SiteEventsIndex (event ordering)

/** Bump when making breaking changes to the schema; renderer branches on it. */
export const SITE_SCHEMA_VERSION = 1 as const;
export type SiteSchemaVersion = typeof SITE_SCHEMA_VERSION;

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** Registered template presets. Each preset seeds default theme/pages/nav. */
export type TemplateId = "pub-venue-v1" | "nightlife-v1" | "clean-modern-v1";

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/** Font family choice — limited allowlist so the deployed bundle stays small. */
export type FontFamilyId = "system" | "serif" | "display";

/**
 * Navigation layout style for the deployed site.
 * - topbar: logo left, links right, hamburger on mobile (classic)
 * - center-logo: logo centered, hamburger opens a full-screen overlay menu; supports logo-split intro animation
 * - overlay-drawer: hamburger-only header on all screen sizes, opens a full-screen menu
 */
export type NavStyleId = "topbar" | "center-logo" | "overlay-drawer";

/** Border-radius scale used across cards/buttons. */
export type RadiusScale = "sm" | "md" | "lg";

/** Color palette. All values are CSS color strings (hex, rgb, hsl). */
export interface SitePalette {
  bg: string;
  text: string;
  muted: string;
  accent: string;
  accentHover: string;
  border: string;
  cardBg: string;
}

export interface ThemeTokens {
  brandName: string;
  /** Swarm reference for uploaded logo image. Site fetches from gateway at runtime. */
  logoSwarmRef?: Hex64;
  /** Short site description for SEO meta tags and social sharing cards (120–160 chars). */
  siteDescription?: string;
  palette: SitePalette;
  fontFamily: FontFamilyId;
  radius: RadiusScale;
  /** Navigation layout. Defaults to "topbar" if absent (backwards compatible). */
  navStyle?: NavStyleId;
  /**
   * Logo-split curtain intro animation. Only applies when navStyle === "center-logo".
   * Defaults to true for nightlife-v1, false otherwise.
   */
  introAnimation?: boolean;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export interface NavItem {
  label: string;
  /** Page slug to link to (must match a `Page.slug` in the same site). */
  pageSlug: string;
}

// ---------------------------------------------------------------------------
// Sections — discriminated union keyed on `type`
// ---------------------------------------------------------------------------

/** Source for an `eventsGrid` section. */
export type EventsGridMode = "upcoming" | "all" | "featured";

export interface OpeningHoursRow {
  /** Day label, e.g. "Mon", "Mon–Fri", "Bank Holidays". Free-form. */
  day: string;
  /** Hours label, e.g. "12:00 – 23:00", "Closed". Free-form. */
  hours: string;
}

export interface GalleryImage {
  ref: Hex64;
  alt: string;
}

/** Vertical breathing room above a section. Creator-controlled. */
export type SectionSpacing = 'compact' | 'default' | 'spacious';

interface SectionBase {
  /** Stable id (ulid) — survives reorders, used as Svelte `{#each}` key. */
  id: string;
  /**
   * Vertical spacing scale for this section. Controls padding-top/bottom via
   * CSS variables injected by SectionRenderer. Defaults to 'default'.
   */
  spacing?: SectionSpacing;
}

export interface HeroSection extends SectionBase {
  type: "hero";
  heading: string;
  subheading?: string;
  ctaLabel?: string;
  /** Internal page slug (`#/whats-on`) or external URL. */
  ctaHref?: string;
  bgImageRef?: Hex64;
}

export interface RichTextSection extends SectionBase {
  type: "richText";
  /** Markdown source. Rendered with a small markdown lib at runtime. */
  markdown: string;
}

export interface GallerySection extends SectionBase {
  type: "gallery";
  /** Optional heading shown above the grid. */
  title?: string;
  images: GalleryImage[];
}

export interface EventsGridSection extends SectionBase {
  type: "eventsGrid";
  /** Optional heading shown above the grid, e.g. "What's On" or "Upcoming Events". */
  title?: string;
  mode: EventsGridMode;
  /** Cap on cards rendered. Omit for unlimited. */
  max?: number;
  /** "date" (default) sorts by startDate ASC; "manual" preserves index order. */
  sortMode?: "date" | "manual";
}

export interface FeaturedEventSection extends SectionBase {
  type: "featuredEvent";
  /** Optional heading shown above the featured card. */
  title?: string;
  /** Event id from this site's `SiteEventsIndex`. */
  eventId: string;
}

export interface OpeningHoursSection extends SectionBase {
  type: "openingHours";
  /** Section heading. Defaults to "Opening Hours" if omitted. */
  title?: string;
  rows: OpeningHoursRow[];
}

export interface MapSection extends SectionBase {
  type: "map";
  /** Optional section heading above the map, e.g. "Find Us". */
  title?: string;
  lat: number;
  lng: number;
  /** Default zoom (1–20). */
  zoom?: number;
  /** Pin label / venue name shown on the map and as address text. */
  label?: string;
}

export interface ContactFormSection extends SectionBase {
  type: "contactForm";
  /** Section heading. Defaults to "Send us a message" if omitted. */
  title?: string;
  /** Where submissions are delivered. Server validates ownership before send. */
  emailTo: string;
}

export interface EmbedSection extends SectionBase {
  type: "embed";
  /** Optional heading shown above the embed. */
  title?: string;
  /** Sanitized at render time. Allowed: <iframe>, basic HTML, Instagram blockquote. */
  html: string;
}

export interface ImageSection extends SectionBase {
  type: "image";
  /** Swarm bytes ref (64-char hex). Empty string = no image yet. */
  ref: Hex64 | "";
  alt: string;
  caption?: string;
  /** full = edge-to-edge within section; contained = centred with max-width. */
  layout: "full" | "contained";
}

export type Section =
  | HeroSection
  | RichTextSection
  | GallerySection
  | ImageSection
  | EventsGridSection
  | FeaturedEventSection
  | OpeningHoursSection
  | MapSection
  | ContactFormSection
  | EmbedSection;

export type SectionType = Section["type"];

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export interface Page {
  /** Path under the site root. Home is "/". Must be unique within a Site. */
  slug: string;
  /** <title> tag + nav label fallback. */
  title: string;
  /** Optional <meta name="description"> for this page. */
  metaDescription?: string;
  sections: Section[];
}

// ---------------------------------------------------------------------------
// Site (top-level)
// ---------------------------------------------------------------------------

export interface SiteContact {
  email?: string;
  phone?: string;
  /** Free-form postal address (multi-line ok). */
  address?: string;
  lat?: number;
  lng?: number;
  /** External map link (Google Maps, Apple Maps). */
  mapUrl?: string;
}

export interface SiteSocials {
  twitter?: string;
  instagram?: string;
  facebook?: string;
  tiktok?: string;
  youtube?: string;
}

export interface Site {
  /** ULID. Permanent — used in feed topics. */
  siteId: string;
  /** Owner wallet address (lowercase). Authoritative for who can edit. */
  ownerAddress: string;
  templateId: TemplateId;
  schemaVersion: SiteSchemaVersion;
  theme: ThemeTokens;
  /** Top-level nav. Order = render order. */
  nav: NavItem[];
  /** All pages in the site. The page with slug "/" is home. */
  pages: Page[];
  contact: SiteContact;
  socials: SiteSocials;
  /**
   * Feed topic for this site's events index. Derived as
   * `woco/site/{siteId}/events` but stored explicitly so the deployed bundle
   * doesn't need to know the derivation rule.
   */
  eventsIndexTopic: string;
  /** Unix ms. */
  createdAt: number;
  /** Unix ms. Bumped on every publish. */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Site events index
// ---------------------------------------------------------------------------

/** Per-event entry in a site's events index. Ordering is render order. */
export interface SiteEventEntry {
  eventId: string;
  /**
   * Optional flag — `featuredEvent` and `eventsGrid mode: "featured"` use this.
   * Default false.
   */
  featured?: boolean;
  /** Unix ms — when this event was added to the site. */
  addedAt: number;
}

export interface SiteEventsIndex {
  siteId: string;
  schemaVersion: SiteSchemaVersion;
  events: SiteEventEntry[];
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Creator site directory — per-owner index stored on Swarm
// ---------------------------------------------------------------------------

/** Compact entry stored in the creator's site directory feed. */
export interface SiteDirectoryEntry {
  siteId: string;
  brandName: string;
  logoSwarmRef?: string;
  accentColor: string;
  feedHash?: string;
  deployedUrl?: string;
  publishedAt: number;
}

/** On-feed envelope (mirrors EventDirectory pattern). */
export interface SiteDirectory {
  v: 1;
  entries: SiteDirectoryEntry[];
  updatedAt: string;
  pages?: number;
}

// ---------------------------------------------------------------------------
// Runtime config (injected into deployed bundle)
// ---------------------------------------------------------------------------

/**
 * Shape injected as `window.SITE_CONFIG` in the deployed site bundle.
 * Multi-page bundles include `site`; legacy single-event bundles include `eventId`.
 */
export interface SiteRuntimeConfig {
  /** Full multi-page site config — present in Phase 1+ bundles. */
  site?: Site;
  /** Legacy single-event id — present in v1 single-event bundles. */
  eventId?: string;
  /** Bee gateway URL for fetching feeds + image refs at runtime. */
  gatewayUrl: string;
  /** API base URL for contactForm POSTs and event reads. */
  apiUrl?: string;
  /** Para wallet API key — injected by single-event site builder. */
  paraApiKey?: string;
  /** Builder preview only — event entries injected from builder state so events
   *  grid renders without requiring the feed to be published first. */
  previewEvents?: SiteEventEntry[];
  /** URL of the WoCo app used for ticket purchasing links (e.g. https://woco.eth.limo).
   *  Injected at deploy time; defaults to https://woco.eth.limo if absent. */
  wocoAppUrl?: string;
  /** Gateway for event images (uploaded to WoCo Bee at creation time, independent of
   *  where the site itself is hosted). Always https://gateway.woco-net.com when set.
   *  Falls back to gatewayUrl when absent (WoCo-hosted sites). */
  contentGatewayUrl?: string;
}

declare global {
  interface Window {
    SITE_CONFIG?: SiteRuntimeConfig;
  }
}
