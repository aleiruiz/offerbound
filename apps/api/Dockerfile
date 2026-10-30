# Offerbound API and worker image. Build from the repository root:
#   docker build -f apps/api/Dockerfile .
# One image, two entry points: apps/api/dist/server.js (API) and apps/api/dist/worker.js (worker).
FROM node:22-alpine

# pnpm is prepared as root but the container runs as `node`: keep corepack's cache in a shared
# place that `node` owns, so `pnpm db:migrate` starts without downloading pnpm from the registry.
ENV COREPACK_HOME=/usr/local/share/corepack

# openssl: the Prisma engines on musl. postgresql17-client: pg_dump for the nightly backup.
RUN apk add --no-cache openssl postgresql17-client \
  && corepack enable \
  && corepack prepare pnpm@9.15.9 --activate \
  && chown -R node:node "$COREPACK_HOME" \
  && mkdir /backups \
  && chown node:node /backups

WORKDIR /app

# Dependencies first so this layer is cached until a manifest or the lockfile changes.
# --workspace-root brings in the root devDependencies (prisma CLI, typescript) that the image
# needs at build time and for `pnpm db:migrate` at start.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile --workspace-root --filter "@offerbound/api..."

COPY tsconfig.base.json tsconfig.json prisma.config.ts ./
COPY prisma prisma
COPY packages/contracts packages/contracts
COPY packages/domain packages/domain
COPY apps/api apps/api
# The demo reads fixtures/ at run time (emails, lead batches, the seed); the code finds the repository
# root by walking up to pnpm-workspace.yaml, which was copied above.
COPY fixtures fixtures

# Generates the client for the native and linux-musl-openssl-3.0.x targets (prisma/schema.prisma).
RUN pnpm db:generate \
  && pnpm --filter @offerbound/contracts --filter @offerbound/domain --filter @offerbound/api run build

# /backups (created above, owned by node) is where compose mounts the backups volume.
ENV NODE_ENV=production
USER node
EXPOSE 3000

# Migrations run on every start; the worker waits for this service to be healthy (compose).
CMD ["sh", "-c", "pnpm db:migrate && exec node apps/api/dist/server.js"]
