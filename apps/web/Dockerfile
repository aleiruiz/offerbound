# Offerbound web image: Vite build served by Caddy. Build from the repository root:
#   docker build -f apps/web/Dockerfile .
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --workspace-root --filter "@offerbound/web..."

COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN pnpm --filter @offerbound/web build

FROM caddy:2-alpine
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
EXPOSE 80
