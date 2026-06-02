import type { Page, Site, ThemeTokens, NavItem, TemplateId } from "./types.js";
import { SITE_SCHEMA_VERSION } from "./types.js";
import { siteEventsIndexTopic } from "./topics.js";

// ---------------------------------------------------------------------------
// Template presets
// ---------------------------------------------------------------------------
//
// A template seeds the default theme + pages + nav for a new site. The
// organiser then edits content via the builder. Adding a second template =
// add a new preset here + extend `TemplateId`.

/** Stable id factory — caller passes a ulid generator (so this stays pure). */
type IdGen = () => string;

/** Pub / venue template — hospitality site with What's On + Visit + Contact. */
function pubVenuePreset(idGen: IdGen): { theme: ThemeTokens; nav: NavItem[]; pages: Page[] } {
  const theme: ThemeTokens = {
    brandName: "Your Venue",
    palette: {
      bg: "#0f0f0f",
      text: "#f5f5f5",
      muted: "#a0a0a0",
      accent: "#d4af37",
      accentHover: "#b8962b",
      border: "#2a2a2a",
      cardBg: "#1a1a1a",
    },
    fontFamily: "serif",
    radius: "sm",
  };

  const nav: NavItem[] = [
    { label: "Home", pageSlug: "/" },
    { label: "What's On", pageSlug: "/whats-on" },
    { label: "Visit", pageSlug: "/visit" },
    { label: "Contact", pageSlug: "/contact" },
  ];

  const pages: Page[] = [
    {
      slug: "/",
      title: "Home",
      sections: [
        {
          id: idGen(),
          type: "hero",
          heading: "Welcome to Your Venue",
          subheading: "A short tagline about what makes this place worth visiting.",
          ctaLabel: "What's On",
          ctaHref: "#/whats-on",
        },
        {
          id: idGen(),
          type: "richText",
          markdown: "## About us\n\nA paragraph or two about the venue, its history, and what guests can expect.",
        },
        {
          id: idGen(),
          type: "eventsGrid",
          mode: "upcoming",
          max: 3,
        },
      ],
    },
    {
      slug: "/whats-on",
      title: "What's On",
      sections: [
        {
          id: idGen(),
          type: "hero",
          heading: "Upcoming events",
          subheading: "Live music, quizzes, supper clubs, and more.",
        },
        {
          id: idGen(),
          type: "eventsGrid",
          mode: "all",
        },
      ],
    },
    {
      slug: "/visit",
      title: "Visit",
      sections: [
        {
          id: idGen(),
          type: "hero",
          heading: "Find us",
        },
        {
          id: idGen(),
          type: "openingHours",
          rows: [
            { day: "Mon – Thu", hours: "12:00 – 23:00" },
            { day: "Fri – Sat", hours: "12:00 – 00:00" },
            { day: "Sun", hours: "12:00 – 22:30" },
          ],
        },
        {
          id: idGen(),
          type: "map",
          lat: 51.5074,
          lng: -0.1278,
          label: "Your Venue",
        },
      ],
    },
    {
      slug: "/contact",
      title: "Contact",
      sections: [
        {
          id: idGen(),
          type: "hero",
          heading: "Get in touch",
        },
        {
          id: idGen(),
          type: "contactForm",
          emailTo: "",
        },
      ],
    },
  ];

  return { theme, nav, pages };
}

/** Nightlife / Club template — dark, dramatic, center-logo nav with optional intro animation. */
function nightlifePreset(idGen: IdGen): ReturnType<typeof pubVenuePreset> {
  const theme: ThemeTokens = {
    brandName: "Your Club",
    palette: {
      bg: "#050505",
      text: "#ffffff",
      muted: "#888888",
      accent: "#a855f7",
      accentHover: "#9333ea",
      border: "#1a1a1a",
      cardBg: "#0d0d0d",
    },
    fontFamily: "display",
    radius: "sm",
    navStyle: "center-logo",
    introAnimation: true,
  };

  const nav: NavItem[] = [
    { label: "Home", pageSlug: "/" },
    { label: "Events", pageSlug: "/events" },
    { label: "About", pageSlug: "/about" },
    { label: "Contact", pageSlug: "/contact" },
  ];

  const pages: Page[] = [
    {
      slug: "/",
      title: "Home",
      sections: [
        {
          id: idGen(),
          type: "hero",
          heading: "Where the night begins",
          subheading: "The city's premier destination for live music, DJs, and unforgettable nights.",
          ctaLabel: "See what's on",
          ctaHref: "#/events",
        },
        {
          id: idGen(),
          type: "eventsGrid",
          mode: "upcoming",
          max: 4,
        },
      ],
    },
    {
      slug: "/events",
      title: "Events",
      sections: [
        {
          id: idGen(),
          type: "hero",
          heading: "Upcoming Events",
        },
        {
          id: idGen(),
          type: "eventsGrid",
          mode: "all",
        },
      ],
    },
    {
      slug: "/about",
      title: "About",
      sections: [
        {
          id: idGen(),
          type: "hero",
          heading: "Our Story",
          subheading: "A great night starts here.",
        },
        {
          id: idGen(),
          type: "richText",
          markdown: "## About us\n\nTell your story here — the vibe, the history, and what makes this place special.",
        },
      ],
    },
    {
      slug: "/contact",
      title: "Contact",
      sections: [
        {
          id: idGen(),
          type: "hero",
          heading: "Get in touch",
        },
        {
          id: idGen(),
          type: "contactForm",
          emailTo: "",
        },
      ],
    },
  ];

  return { theme, nav, pages };
}

/** Clean / Modern template — light, airy, versatile for arts, galleries, cultural orgs. */
function cleanModernPreset(idGen: IdGen): ReturnType<typeof pubVenuePreset> {
  const theme: ThemeTokens = {
    brandName: "Your Organisation",
    palette: {
      bg: "#ffffff",
      text: "#1a1a1a",
      muted: "#6b7280",
      accent: "#2563eb",
      accentHover: "#1d4ed8",
      border: "#e5e7eb",
      cardBg: "#f9fafb",
    },
    fontFamily: "system",
    radius: "md",
    navStyle: "overlay-drawer",
    introAnimation: false,
  };

  const nav: NavItem[] = [
    { label: "Home", pageSlug: "/" },
    { label: "What's On", pageSlug: "/whats-on" },
    { label: "About", pageSlug: "/about" },
    { label: "Contact", pageSlug: "/contact" },
  ];

  const pages: Page[] = [
    {
      slug: "/",
      title: "Home",
      sections: [
        {
          id: idGen(),
          type: "hero",
          heading: "Welcome",
          subheading: "A short, compelling line about what you do and why it matters.",
          ctaLabel: "What's On",
          ctaHref: "#/whats-on",
        },
        {
          id: idGen(),
          type: "richText",
          markdown: "## About us\n\nA paragraph about your organisation, its mission, and what guests can expect.",
        },
        {
          id: idGen(),
          type: "eventsGrid",
          mode: "upcoming",
          max: 3,
        },
      ],
    },
    {
      slug: "/whats-on",
      title: "What's On",
      sections: [
        {
          id: idGen(),
          type: "hero",
          heading: "Upcoming Events",
        },
        {
          id: idGen(),
          type: "eventsGrid",
          mode: "all",
        },
      ],
    },
    {
      slug: "/about",
      title: "About",
      sections: [
        {
          id: idGen(),
          type: "hero",
          heading: "About us",
        },
        {
          id: idGen(),
          type: "richText",
          markdown: "## Our story\n\nTell your story here. Who you are, what you do, and what makes your events worth attending.",
        },
      ],
    },
    {
      slug: "/contact",
      title: "Contact",
      sections: [
        {
          id: idGen(),
          type: "hero",
          heading: "Get in touch",
        },
        {
          id: idGen(),
          type: "contactForm",
          emailTo: "",
        },
      ],
    },
  ];

  return { theme, nav, pages };
}

const PRESETS: Record<TemplateId, (idGen: IdGen) => ReturnType<typeof pubVenuePreset>> = {
  "pub-venue-v1": pubVenuePreset,
  "nightlife-v1": nightlifePreset,
  "clean-modern-v1": cleanModernPreset,
};

/** Build a new `Site` from a template preset. Caller supplies ids + owner. */
export function newSiteFromTemplate(args: {
  siteId: string;
  ownerAddress: string;
  templateId: TemplateId;
  idGen: IdGen;
  now?: number;
}): Site {
  const { siteId, ownerAddress, templateId, idGen } = args;
  const now = args.now ?? Date.now();
  const preset = PRESETS[templateId](idGen);

  return {
    siteId,
    ownerAddress: ownerAddress.toLowerCase(),
    templateId,
    schemaVersion: SITE_SCHEMA_VERSION,
    theme: preset.theme,
    nav: preset.nav,
    pages: preset.pages,
    contact: {},
    socials: {},
    eventsIndexTopic: siteEventsIndexTopic(siteId),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Single-page storefront site for a shop — hero + productGrid. Deployed through
 * the standard site publish/deploy pipeline, so a merchant can put a shop online
 * at its own URL without building a full multi-page website. "Expand into a full
 * website" later just opens this same site in the builder. See docs/SHOP_IA.md.
 */
export function newSiteFromShop(args: {
  siteId: string;
  ownerAddress: string;
  shopId: string;
  shopName: string;
  idGen: IdGen;
  now?: number;
}): Site {
  const { siteId, ownerAddress, shopId, shopName, idGen } = args;
  const now = args.now ?? Date.now();

  const theme: ThemeTokens = {
    brandName: shopName,
    siteDescription: `${shopName} — browse the shop and check out in seconds.`,
    palette: {
      bg: "#0B0B09",
      text: "#F5F0EA",
      muted: "#8A857C",
      accent: "#C7F23A",
      accentHover: "#B4DE2E",
      border: "#2A2824",
      cardBg: "#15140F",
    },
    fontFamily: "system",
    radius: "md",
    navStyle: "topbar",
  };

  const nav: NavItem[] = [{ label: "Shop", pageSlug: "/" }];

  const pages: Page[] = [
    {
      slug: "/",
      title: shopName,
      sections: [
        { id: idGen(), type: "hero", heading: shopName, subheading: "Browse the shop and check out in seconds." },
        { id: idGen(), type: "productGrid", shopId, title: "Shop" },
      ],
    },
  ];

  return {
    siteId,
    ownerAddress: ownerAddress.toLowerCase(),
    templateId: "clean-modern-v1",
    schemaVersion: SITE_SCHEMA_VERSION,
    theme,
    nav,
    pages,
    contact: {},
    socials: {},
    eventsIndexTopic: siteEventsIndexTopic(siteId),
    createdAt: now,
    updatedAt: now,
  };
}

/** Catalogue entry shown in the template-picker step of the builder. */
export interface TemplateCatalogueEntry {
  id: TemplateId;
  name: string;
  description: string;
  /** Recommended for what kind of organiser. */
  bestFor: string[];
}

export const TEMPLATE_CATALOGUE: TemplateCatalogueEntry[] = [
  {
    id: "pub-venue-v1",
    name: "Pub & Venue",
    description: "Warm hospitality site with gold accents on dark tones. Multi-page: home, what's on, visit, contact. Classic top-bar navigation.",
    bestFor: ["Pubs", "Bars", "Restaurants", "Live music venues", "Hotels"],
  },
  {
    id: "nightlife-v1",
    name: "Nightlife & Club",
    description: "High-impact dark design with dramatic logo-split intro animation and a full-screen overlay menu. Built for maximum impression.",
    bestFor: ["Nightclubs", "DJs", "Promoters", "Festivals", "Entertainment"],
  },
  {
    id: "clean-modern-v1",
    name: "Clean & Modern",
    description: "Light, airy design with generous whitespace and an understated overlay drawer menu. Versatile and professional.",
    bestFor: ["Arts venues", "Galleries", "Cultural orgs", "Festivals", "Community events"],
  },
];
