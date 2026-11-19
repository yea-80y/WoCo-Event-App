# Licensing

WoCo is building towards a world computer: an internet where people own their identity, their
tickets and their data, and anyone can build on shared, open infrastructure. Our licensing is
set up to serve that. The parts others need to build with are open source. The WoCo app itself
is source-available, opens up fully over time, and we would rather collaborate than say no.

This page is a plain-English guide. The `LICENSE` files are the legal terms.

## At a glance

| Part | Licence | In short |
|---|---|---|
| `packages/shared` - ticket, manifest and statement formats, signing and verification | [MIT](../packages/shared/LICENSE) | Open source. Use it for anything. |
| WoCo contracts (the separate [`contracts`](./CONTRIBUTING.md#4-contracts-is-a-different-repository) repository) | MIT | Open source. Use it for anything. |
| Everything else in this repository - app, server, scanner, embed, seat map, registry | [FSL-1.1-MIT](../LICENSE) | Source-available now. Each version becomes MIT two years after release. |
| Third-party code and assets (for example the fonts in `apps/server/src/assets/fonts`) | Their own licences | See the licence file beside them. |

Everything published before this change remains available under MIT.

## An open ticket standard

A ticket should not depend on the company that sold it. The formats that define a WoCo ticket -
how it is issued, signed and checked at the door - are MIT so that anyone can build a wallet, a
scanner, an indexer or a whole new frontend that reads and verifies them, without asking. If you
are building on them, tell us: we want them to become a shared standard rather than a WoCo one,
and we welcome proposals and changes.

## The app: FSL-1.1-MIT

The rest of the repository uses the [Functional Source License](https://fsl.software/), a
licence created by Sentry for companies that want their code open to read, run and improve
while they build a sustainable business around it.

**You can, without asking:**
- read, run, modify and learn from the code
- use it for your own internal purposes
- use it for non-commercial education and research
- build tools and integrations that work with WoCo
- contribute improvements back

**The one thing it rules out** is a *Competing Use*: offering this software, or something
substantially similar built from it, to others as a commercial product or service. The
[`LICENSE`](../LICENSE) has the exact wording.

**And it expires.** Each version (each commit on `main`) becomes available under MIT on the
second anniversary of its publication, automatically and irrevocably. To get the newest version
that has converted:

```
git checkout $(git rev-list -n 1 --before="2 years ago" main)
```

Organisers, attendees and anyone using WoCo or embedding its ticket widget do not need to do
anything: the licence covers the source code, not use of the service.

## Ask us

We chose the FSL to give a young company room to grow, not to stop people building. If you have
an idea the licence would rule out - running your own instance for a venue group, a deployment
for a region or community we do not serve, a fork that takes the project somewhere new - get in
touch. If it moves the world computer forward, the likely answer is yes, through a simple written
permission, a commercial licence or a partnership. If you are not sure whether your idea is a
Competing Use, ask and we will give you a clear answer in writing.

Contact: **support@woco-net.com**, or open an issue on this repository.

## Our licensing position

We review our licensing as WoCo and its ecosystem grow. We are open to changing it - for
example, releasing further components under an OSI-approved open source licence, or moving the
whole codebase to one - where that supports a grant programme, an ecosystem partnership, a
public-good funder or a collaborator working towards the same goals. Proposals are welcome at
the contact above.

## Contributions

Contributions are welcome. You license each contribution to us under the MIT licence; we then
publish it under whichever licence covers the directory it lands in. Contributing under MIT keeps
the two-year conversion and any permission we grant a collaborator clean, without a separate
contributor agreement. Opening a pull request confirms that you have the right to contribute the
work under these terms. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Licensor and trademarks

The licensor is **WoCo Network Ltd**, a company registered in England and Wales (number
17370809). None of these licences grants any right to the WoCo name or logo.
