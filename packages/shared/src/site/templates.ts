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

const PRESETS: Record<TemplateId, (idGen: IdGen) => ReturnType<typeof pubVenuePreset>> = {
  "pub-venue-v1": pubVenuePreset,
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
    name: "Pub / Venue",
    description: "Multi-page hospitality site with home, events, visit, and contact pages. Designed for pubs, bars, restaurants, and small music venues.",
    bestFor: ["Pubs", "Bars", "Restaurants", "Live music venues", "Hotels"],
  },
];
