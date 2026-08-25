FROM node:24-alpine

WORKDIR /app

# ── Workspace manifests first (Docker layer cache) ──────────────────────────
COPY package.json package-lock.json ./
COPY apps/server/package.json       ./apps/server/
COPY packages/shared/package.json   ./packages/shared/
COPY packages/embed/package.json    ./packages/embed/

# Install all workspace deps (includes tsx + vite needed at runtime/build)
RUN npm install

# ── Source ──────────────────────────────────────────────────────────────────
COPY packages/shared/   ./packages/shared/
COPY packages/embed/    ./packages/embed/
COPY apps/server/src    ./apps/server/src
COPY apps/server/tsconfig.json ./apps/server/

# The deployed commit, written by scripts/deploy-server.sh from the SHA it
# verified just before the rsync (#125). The glob is deliberate: it tolerates
# the file being absent, so a build from a plain checkout still works and simply
# reports an unknown commit rather than failing.
COPY .deploy-commit* ./

# Ops scripts must ship with the image: payout-schedule-audit.ts is the documented
# post-deploy step (docs/PAYOUTS.md §9) and has to run against the live .data store
COPY apps/server/scripts ./apps/server/scripts

# Build the embed widget so /embed/woco-embed.js is served correctly
RUN npm run build:embed

EXPOSE 3001

CMD ["node", "--import", "tsx", "apps/server/src/index.ts"]
