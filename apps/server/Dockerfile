FROM node:20-alpine

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

# Build the embed widget so /embed/woco-embed.js is served correctly
RUN npm run build:embed

EXPOSE 3001

CMD ["node", "--import", "tsx", "apps/server/src/index.ts"]
