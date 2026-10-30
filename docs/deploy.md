# Deploying Offerbound

Offerbound runs on the owner's VPS under Coolify as a Docker Compose resource, the same way MTGRulesLawyer does. This guide creates the private instance, `offerbound-private`, at `https://alei.offerbound.northsoftmx.com`. Follow the steps in order. Every step can be done from a phone browser except where it says "needs a terminal".

Authority: [TECHNICAL_SPEC](TECHNICAL_SPEC.md) section 3 (deployment) and section 16 (operations), [SECURITY](SECURITY.md) sections 10 and 14.

What gets deployed (`/compose.prod.yaml`):

| Service  | What it is                                                                  | Public            |
| -------- | --------------------------------------------------------------------------- | ----------------- |
| `web`    | Caddy: serves the React app and proxies `/api/*`, `/health`, `/ready`       | Yes, via Coolify  |
| `api`    | Fastify API. Runs database migrations on every start                        | No                |
| `worker` | Background jobs (pg-boss): Gmail sync, email pipeline, backups, timers      | No                |
| `db`     | Postgres 17, volume `postgres-data`                                         | No                |

No service publishes a port. Coolify's proxy reaches `web` on the Docker network and issues the TLS certificate.

The `api` and `worker` containers run from `WORKDIR /app` (the repository root), so the start command is `node apps/api/dist/server.js` (TECHNICAL_SPEC section 3.1 writes it relative to `apps/api`).

## Checklist

### 1. DNS (GoDaddy)

- [ ] Add an `A` record for host `alei.offerbound` pointing to the VPS IP address.
- [ ] (Release 1.1, demo) Add an `A` record for host `offerbound` pointing to the same IP.

Coolify issues one certificate per host once the record resolves.

### 2. Google Cloud (OAuth client)

Do this once, before the first deploy, so the client ID and secret are ready for step 5.

- [ ] Create the project _Offerbound_ and enable the **Gmail API**.
- [ ] _Google Auth Platform_, Branding: app name _Offerbound_, support email `<owner Gmail address>`, homepage `https://offerbound.northsoftmx.com`, authorised domain `northsoftmx.com`. If the console asks you to verify the domain, verify it in Search Console with a GoDaddy `TXT` record (OQ-8). Do it only if asked.
- [ ] Data access: add the scopes `openid`, `email`, `profile` and `https://www.googleapis.com/auth/gmail.readonly`. Nothing else.
- [ ] Audience: **External**, then **Publish app** so the status is _In production_. This avoids refresh tokens that expire after 7 days. The app stays unverified, so Google shows an "unverified app" screen at sign-in. That is expected.
- [ ] Credentials, _OAuth client ID_, type **Web application**. Authorised redirect URI, exactly:
      `https://alei.offerbound.northsoftmx.com/api/v1/auth/google/callback`
      (For local development you can add `http://localhost:5173/api/v1/auth/google/callback` as a second URI.)
- [ ] Copy the client ID and client secret somewhere safe. They go into Coolify in step 5.

### 3. OpenAI key

- [ ] In OpenAI, create a dedicated project named _offerbound_ and create an API key in it. Copy the key. It goes into Coolify in step 5.
- [ ] Note the per-million-token prices of the model you will use and the per-call price of the web search tool from OpenAI's pricing page. They fill `AI_PRICING` and `AI_WEB_SEARCH_COST_PER_CALL_MICROS`.

### 4. Create the resource in Coolify

- [ ] Coolify, _Projects_, choose a project, _+ New Resource_, **Private Repository (with GitHub App)**. Pick the server and the GitHub App that can see the repository.
- [ ] Repository `aleiruiz/offerbound`, branch `main`. Build pack **Docker Compose**.
- [ ] _Docker Compose Location_: `/compose.prod.yaml`.
- [ ] Name the resource `offerbound-private`.
- [ ] Open the resource's configuration. Find the service **`web`** and set its domain to `https://alei.offerbound.northsoftmx.com`. Only `web` gets a domain. Save.
- [ ] Do not deploy yet.

### 5. Environment variables

Coolify, the resource, _Environment Variables_. After the first save Coolify lists every variable that `compose.prod.yaml` mentions. Add the values below.

For every row marked **secret**, leave **Available at buildtime off**, so the value is runtime-only. Secrets must never be build variables. A missing required variable stops the deploy and the error names it.

| Variable                             | Required | Secret | Value or default                                                                                             | Purpose                                         |
| ------------------------------------ | -------- | ------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `APP_MODE`                           | yes      | no     | `private`                                                                                                    | Mode switch                                     |
| `PUBLIC_BASE_URL`                    | yes      | no     | `https://alei.offerbound.northsoftmx.com`                                                                    | Redirects and cookies                           |
| `SERVICE_PASSWORD_POSTGRES`          | auto     | yes    | Generated by Coolify. Do not set or change it (see the note below)                                                                | Postgres password; `DATABASE_URL` is built from it |
| `OWNER_EMAIL`                        | yes      | yes    | `<owner Gmail address>`                                                                                      | The only Google account allowed to sign in      |
| `GOOGLE_CLIENT_ID`                   | yes      | yes    | From step 2                                                                                                  | OAuth                                           |
| `GOOGLE_CLIENT_SECRET`               | yes      | yes    | From step 2                                                                                                  | OAuth                                           |
| `TOKEN_ENCRYPTION_KEY`               | yes      | yes    | 32 random bytes, base64. Generate it as shown below                                                          | AES-256-GCM encryption of Google tokens         |
| `OPENAI_API_KEY`                     | yes      | yes    | From step 3                                                                                                  | OpenAI project _offerbound_                     |
| `AI_PRICING`                         | yes      | no     | JSON, see below                                                                                              | Cost accounting                                 |
| `AI_WEB_SEARCH_COST_PER_CALL_MICROS` | yes      | no     | Price of one web search call in millionths of a dollar, for example `10000` is 0.01 dollars                  | Cost accounting                                 |
| `USER_TIMEZONE`                      | no       | no     | `America/Monterrey`                                                                                          | Day boundaries, schedules, display              |
| `HOME_COUNTRY`                       | no       | no     | `MX`                                                                                                         | "Remote from home country" eligibility          |
| `OPENAI_MODEL_TRIAGE`, `OPENAI_MODEL_EXTRACT`, `OPENAI_MODEL_RANK`, `OPENAI_MODEL_SEARCH`, `OPENAI_MODEL_PROFILE` | no | no | Application default (TECHNICAL_SPEC section 8.2) | Model per purpose                |
| `OPENAI_REASONING_EFFORT_TRIAGE`, `_EXTRACT`, `_RANK`, `_SEARCH`, `_PROFILE` | no | no | triage `low`, extract `low`, rank `low`, search `medium`, profile `low` | Reasoning effort per purpose |
| `GMAIL_BACKFILL_SINCE`               | no       | no     | `2026-09-01`                                                                                                 | First sync start date                           |
| `GMAIL_SYNC_INTERVAL_MINUTES`        | no       | no     | `5`                                                                                                          | Sync interval                                   |
| `SEARCH_MAX_TOOL_CALLS_PER_ROUND`    | no       | no     | `40`                                                                                                         | Search limit                                    |
| `SEARCH_MAX_ROUNDS`                  | no       | no     | `3`                                                                                                          | Search limit                                    |
| `BACKUP_RETENTION_DAYS`              | no       | no     | `14`                                                                                                         | Nightly backups kept                            |
| `TRUSTED_PROXY_IPS`                  | no       | no     | `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` (Docker private ranges). See the note below                        | Client IP for rate limits                       |
| `LOG_LEVEL`                          | no       | no     | `info`                                                                                                       | Log verbosity                                   |

`SERVICE_PASSWORD_POSTGRES` is generated by Coolify the first time the compose file is read. Postgres reads it only when the `postgres-data` volume is first initialised, so do not regenerate or edit it later: the database would keep the old password and the `api` could no longer connect.

Leave an optional variable empty or unset to use its default. `DATABASE_URL` and `PORT` are not set in Coolify: compose builds the first and the API listens on 3000.

**Generate `TOKEN_ENCRYPTION_KEY`** (needs a terminal: the Coolify server terminal, any Linux or Mac terminal, or Cloud Shell in Google Cloud Console, which works from a phone):

```sh
openssl rand -base64 32
```

The output is one line of 44 characters ending in `=`. Paste it as the value. Also store it in your password manager. Backups contain Google tokens in encrypted form, so a lost key means reconnecting Gmail and old backups cannot be decrypted. Never reuse a key from another app and never paste it in chat or commit it.

**`AI_PRICING`** is one line of JSON keyed by model name. The prices are in millionths of a dollar per million tokens. Use your own numbers from the OpenAI pricing page; this shows only the shape:

```json
{"<model name>":{"inputPerMTokMicros":<n>,"cachedInputPerMTokMicros":<n>,"outputPerMTokMicros":<n>}}
```

Every model used by a purpose needs an entry, otherwise its calls show "unknown" cost in the AI usage view.

**`TRUSTED_PROXY_IPS` must cover the real proxy chain.** Requests reach the API as client, Coolify proxy (Traefik), `web` (Caddy), `api`. The API takes the client address from `X-Forwarded-For` only when the connection comes from a trusted address. The default covers Docker's private ranges, which is right for Coolify. If you narrow it, or your Docker network uses a public range, the API sees every visitor as one address and they all share one rate-limit bucket, so one noisy client locks out the rest (including you). Keep the default unless you know the exact subnets. The other half of the chain is `trusted_proxies static private_ranges` in `apps/web/Caddyfile`, which makes Caddy keep the client address that Traefik forwards; without it `TRUSTED_PROXY_IPS` cannot help.

### 6. Notifications

- [ ] Coolify, _Notifications_: enable at least one channel (email, Telegram or Discord) and turn on **deployment failures** (also **container status changes** if offered). A failed deploy is otherwise silent.

### 7. Deploy

- [ ] Open the resource and press **Deploy**. The first build takes a few minutes. Order: `db` healthy, `api` builds, runs migrations and becomes healthy, then `worker` and `web` start.
- [ ] If the deploy fails with `required variable <NAME> is missing a value`, add that variable in step 5 and deploy again.

Check it works:

- [ ] `https://alei.offerbound.northsoftmx.com/ready` answers 200 with `{"status":"ready"}`.
- [ ] `https://alei.offerbound.northsoftmx.com/` shows the sign-in page.
- [ ] The response headers include the CSP. From a terminal: `curl -sI https://alei.offerbound.northsoftmx.com/ | grep -i content-security-policy`.

### 8. Google consent check (OQ-1, owner)

- [ ] Open `https://alei.offerbound.northsoftmx.com` and sign in with Google with `<owner Gmail address>`.
- [ ] Google shows an "unverified app" screen. Choose _Advanced_, then _Go to Offerbound (unsafe)_, and grant Gmail access.
- [ ] Verify what was stored. Coolify, the resource, service `db`, _Terminal_ (or `docker exec` on the server), run:

```sh
psql -U offerbound -d offerbound -c "select status, scopes from gmail_connection"
```

Expect one row with status `active` and `gmail.readonly` in the scopes.

**If Google refuses the consent** (OQ-1 fallback, approved in OPEN_QUESTIONS): in _Google Auth Platform, Audience_ switch the publishing status back to **Testing** and add `<owner Gmail address>` as a test user. In Testing, refresh tokens last 7 days, so Gmail needs reconnecting weekly. Record the outcome in `docs/OPEN_QUESTIONS.md` (mark OQ-1 answered) and tell the owner.

## Operations

- **Updates:** push to `main`, then press **Deploy** (or enable auto-deploy from the GitHub App). Migrations run on api start. The worker restarts after the api is healthy. Running jobs get 30 seconds to finish on stop.
- **Logs:** Coolify, the resource, _Logs_ per service. Logs are JSON and never contain email content.
- **Backups:** the worker writes `pg_dump -Fc` files to `/backups/offerbound-YYYY-MM-DD.dump` at 03:30 in the owner time zone and keeps `BACKUP_RETENTION_DAYS` days. They sit on the same host as the database; off-server copies are OQ-3.
- **Restore** (TECHNICAL_SPEC section 16): stop `worker`, run `pg_restore --clean --if-exists -d "$DATABASE_URL" <file>` from the `worker` container terminal (it has the Postgres client and the `/backups` volume), start `worker`.
- **Rotating a secret:** change the value in Coolify and redeploy. For a suspected compromise follow the incident playbook in SECURITY section 13.
- **Demo instance (Release 1.1):** a second resource, `offerbound-demo`, on `https://offerbound.northsoftmx.com` with `APP_MODE=demo` and no secrets. The current `compose.prod.yaml` requires the private variables, so the demo needs a variant of the compose file; that is Release 1.1 work.

## Images

Both images build from the repository root:

```sh
docker build -f apps/api/Dockerfile .   # api and worker
docker build -f apps/web/Dockerfile .   # web (Vite build served by Caddy)
```

CI builds them in the `images` job on every pull request.
