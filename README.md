# Offerbound

A job-search tracker that reads job-related email, keeps applications up to date and surfaces leads.

## Development

Requires Node 22 and pnpm 9.15.9 (`corepack enable`).

```sh
cp .env.example .env
docker compose up -d      # local Postgres 17 (or use any Postgres on localhost:5432)
pnpm install
pnpm test                 # unit then integration tests
pnpm lint && pnpm typecheck && pnpm format:check
```

Specification and plan live in `docs/`.
