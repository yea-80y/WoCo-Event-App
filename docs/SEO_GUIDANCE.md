# SEO guidance — the user-facing copy

The words we actually show organisers. Written as product copy, not prose: #72 (the
builder guidance panel) should wire these strings in rather than re-invent them, and any
future session writing SEO help text should start here so the product speaks with one voice.

Strategy, decisions and current-state audit live in `docs/SEO_PLAN.md`. This file is only
"what do we say to the user".

## The framework — three things on a post-it

Everything below is one of these three. If a proposed feature isn't, it's probably not SEO.

1. **Meta titles + descriptions** — the advert in the search result. Wins the click.
2. **H1/H2 headings** — what the page is about, in the words people type.
3. **Links with descriptive anchor text** — how pages are found and understood.

The unstated fourth: **one page = one URL = one search intent**. That's plumbing, ours to
fix (#70/#71), never the organiser's problem.

## Where each surface gets its SEO

Automation is the default. We only ask the organiser for something when a machine genuinely
cannot decide it.

| Surface | How | Organiser sees |
|---|---|---|
| Event page | **Fully automatic** — derived from title, tagline, dates, geocoded location, genre tags, image, price (#55) | Nothing. No SEO UI, ever. |
| Events list on a website | **Automatic** — `ItemList` of Events | Nothing |
| Website pages | **Guided** — titles/descriptions are editorial judgement | The panel below (#72) |
| Site-wide description | Guided | One field in Brand tab |

The rule of thumb: **if we already asked for it once, never ask again for SEO's sake.**

## Panel copy — website pages

### Page title

> **Title** — this is the blue link in Google. 50-60 characters.
>
> Use the shape: **what you are + where you are + your name.**
> *Craft beer pub in Camden | The Lock Tavern*
>
> Avoid "Home", "Welcome" or "Untitled" — nobody searches for those.

Checks: length 50-60 (warn outside 30-70); flag titles matching `home|welcome|untitled|page \d+`.

### Meta description

> **Description** — the grey text under the link. It doesn't affect ranking, it affects
> whether anyone clicks. 120-160 characters.
>
> Say what someone gets, and include the place name.
> *Independent Camden pub serving craft ales, wood-fired pizza and live music six nights a week.*

Checks: length 120-160 (warn outside 70-200); warn if the town/city from the site's contact
details appears nowhere in it.

### The ambiguity test

> **Would a stranger type this into Google?**
>
> "What's On" — no. Nobody searches those words.
> "Live music in Camden this week" — yes.
>
> Same page. One is invisible.

This is the single most useful thing we say. Show it against the page title, always.

### Headings

> **One H1 per page, and it should say the same thing as your title — in human words.**
>
> Your H1 is the big heading at the top. Google uses it to confirm what the page is about,
> so "Live music every Friday" beats "Welcome".

Checks: zero H1s on the page (a page with no hero section has none) → warn; two or more →
warn and offer to demote the extras.

### Body copy

> **Write place names, not pronouns.**
>
> "We're right by the station" → "two minutes from Camden Town station".
>
> Google can't work out who "we" are or where "here" is. Neither can someone who's never
> been.

Check: town/city name appears nowhere in the page's text.

### Links

> **Say where the link goes.**
>
> "Click here" → "Book our Friday live music night".
>
> Link text is one of the strongest signals for the page you're linking to — spend it.

Check: any link text in {click here, read more, more info, here, link, this page}.

### One page, one job

> **A page about food *and* music *and* your history ranks for nothing.**
>
> Split it. One page per thing people actually search for.

Shown once, at page level, when a page carries more than ~4 sections of different types.

## Domain guidance

> **SEO starts when you connect your own domain.**
>
> Search engines build a site's reputation against its address. On a shared WoCo address
> you're building that reputation for us, not for you — and it can't move with you.
>
> A domain costs about £10 a year. It's the single highest-value thing you can do here.

Shown in the Domain tab, above the CNAME instructions. Never nags more than once per session.

## Tone rules

- **Never use the word "SEO"** in user-facing copy unless the organiser used it first. Say
  "how you show up in Google".
- **No jargon**: no "meta", "canonical", "structured data", "crawler", "index".
- **Always show the fixed version**, not just the problem. "What's On" → "Live music in
  Camden this week" teaches in one line; "your title is too vague" teaches nothing.
- **Warn, never block.** A bad title still publishes. This is advice, not validation.
- **Score honestly.** If a page is fine, say it's fine and get out of the way.
