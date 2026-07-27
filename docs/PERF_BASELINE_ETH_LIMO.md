# Frontend load-time baseline — woco.eth.limo

Method: Lighthouse (local chromium via `npx`, no install needed), performance
category only, 3 routes x 2 throttle profiles. Routes are hash-based SPA
routes — loading a URL with `#/route` directly still exercises real network
behavior for that route's lazy-loaded JS chunk (see `project_frontend_perf`
memory: lazy routes shipped 2026-07-12).

Rerun script: `scripts/perf-test-eth-limo.sh <suffix> [base-url]`
Summarize:    `python3 scripts/perf-summarize.py /tmp/lighthouse-<suffix>`

> The `.sh` is **local-only** — `.gitignore:33` excludes `*.sh` by project policy, so it
> is not in the repo and never will be. `perf-summarize.py` IS tracked. If the shell
> script is missing on a fresh checkout, that is expected, not a lost file.

To keep it apples-to-apples: run at a similar time of day (Swarm gateway/bee
load varies), don't run other heavy traffic against the same bee concurrently,
and diff against this same table rather than eyeballing raw numbers.

## BEFORE frontend redeploy — 2026-07-17

Base URL: `https://woco.eth.limo`

| report            | score | FCP_ms | LCP_ms | TTI_ms | TBT_ms | SpeedIndex_ms | TotalKB |
|--------------------|------:|-------:|-------:|-------:|-------:|--------------:|--------:|
| home-desktop       | 59    | 4264   | 4274   | 4275   | 0      | 4352          | 704     |
| home-mobile        | 57    | 8054   | 8155   | 8200   | 28     | 9558          | 706     |
| builder-desktop    | 59    | 4247   | 4565   | 4565   | 0      | 4351          | 843     |
| builder-mobile     | 55    | 7346   | 10043  | 10043  | 151    | 9381          | 849     |
| dashboard-desktop  | 59    | 4103   | 4406   | 4406   | 0      | 4114          | 845     |
| dashboard-mobile   | 56    | 7326   | 8564   | 9011   | 124    | 8924          | 844     |

**Important context**: `server-response-time` (TTFB) alone on home-mobile was
**3357ms** — that's ENS (eth.limo) -> gateway.woco-net.com -> Swarm feed
manifest resolution, before any JS starts downloading. That's fixed
infrastructure latency, not bundle size. A frontend-only redeploy (smaller
JS, more lazy-splitting) will move FCP/LCP/TTI by however much it shaves off
download+parse+execute time *on top of* that ~3.3s floor — don't expect the
whole number to collapse.

## AFTER frontend redeploy — (pending)

Rerun the script with suffix `after` once deployed, then paste the table here.
