# Cookie and Local Storage Notice

**Last updated:** [DATE OF PUBLICATION]
**Version:** 1.0

> **⚠️ PRE-LAUNCH DRAFT.** Verify the itemised table against the shipped build before publishing —
> this notice must describe what the app actually stores, and PECR reg. 6 requires accuracy.

---

## The short version

**WoCo uses no advertising cookies, no tracking cookies, and no third-party analytics.**

We store things in your browser that the app cannot function without: your session, some cached data
so pages load quickly, and your preferences. Under PECR regulation 6, storage that is *strictly
necessary* to provide a service you requested does not require consent — which is why you are not
being shown a cookie banner.

If we ever add analytics or advertising, we will ask for your consent first, properly, with a real
choice.

---

## What we store, and why

### Strictly necessary — no consent required

| Name / purpose | Type | What it does | Retention |
|---|---|---|---|
| Session and authentication | Local storage | Keeps you signed in; holds your session delegation | Until sign-out or expiry (30 days) |
| Account keys | IndexedDB | Stores your encrypted local account key, where you use one | Until you delete it |
| Cached event and site data | Local storage | Lets pages load instantly instead of refetching | Short-lived, per the cache TTL |
| Reservation client key | Local storage | Identifies your browser's seat holds so they aren't duplicated | ~10 minutes |
| Purchase recovery | Session storage | Preserves payment proof if a page reload interrupts checkout | Until the tab closes |
| Preferences | Local storage | Remembers your settings and dismissed prompts | Until you clear it |

### Third parties you interact with directly

These set their own storage under their own policies. We do not control them and they do not report
back to us.

| Who | When | Their policy |
|---|---|---|
| **Stripe** | At card checkout, and for fraud prevention | [stripe.com/privacy](https://stripe.com/privacy) |
| **Web3Auth** | Only if you sign in with social or email | [web3auth.io/privacy-policy](https://web3auth.io/privacy-policy.html) |
| **Your wallet provider** | Only if you connect a crypto wallet | Varies by provider |
| **Cloudflare** | Security and DDoS protection on our domains | [cloudflare.com/privacypolicy](https://www.cloudflare.com/privacypolicy/) |

---

## Managing it

You can clear site data at any time through your browser settings.

**Be aware:** clearing storage will sign you out, and **if you use a local browser account, it may
delete the only copy of your key**. Where you control your keys, we cannot recover them. Please make
sure you have set up recovery before clearing browser data.

---

## Sites published by organisers

Organisers publish standalone sites through WoCo. Those sites use the same strictly necessary storage
described above. An organiser may add their own embedded content — a map, a video, a social feed —
which can set third-party cookies outside our control and outside the organiser's site notice.

---

## Contact

Questions: privacy@woco-net.com

See also the [Privacy Policy](./PRIVACY_POLICY.md).
