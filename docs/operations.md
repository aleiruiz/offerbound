# Operations

Day-to-day running of a private Offerbound instance on Coolify (compose services `db`, `api`, `worker`, `web`). First deployment is in [deploy.md](deploy.md); the design is in TECHNICAL_SPEC sections 9 and 16 and SECURITY section 13. Angle brackets such as `<backup-file>` are placeholders for your own values.

## Where things are

| What | Where |
|---|---|
| Database | service `db`, Docker volume `postgres-data` |
| Backups | Docker volume `backups`, mounted at `/backups` in the `worker` service |
| Logs | Coolify, the resource, _Logs_ tab, one stream per service (`api`, `worker`, `web`, `db`) |
| Job state | tables in the `pgboss` schema of the application database (included in backups) |

## Logs

- The `api` and `worker` write JSON lines (pino) to standard output; Docker and Coolify keep them. There are no log files inside the containers.
- Logs carry ids, job names, durations and outcome codes. They never contain email bodies, subjects, previews, sender names, CV text, the brief, prompts, model output, tokens, cookies, `Authorization` headers or the database URL (SECURITY section 4).
- `LOG_LEVEL` sets the verbosity (default `info`). Change it in Coolify and redeploy.
- A failed backup logs `backup: pg_dump failed` with the exit code and the first 500 characters of `pg_dump`'s own error text. The job then fails and pg-boss retries it twice.

## Backups

- **When:** `backup.nightly` runs at 03:30 in `USER_TIMEZONE` on a private instance. Demo instances do not run it.
- **What:** `pg_dump -Fc` of the whole application database, written to `/backups/offerbound-YYYY-MM-DD.dump`. The date is the owner's calendar day, not the UTC day. A second run on the same day replaces that day's file.
- **Retention:** after a successful dump, files named `offerbound-YYYY-MM-DD.dump` that are more than `BACKUP_RETENTION_DAYS` days old (default 14) are deleted. A failed dump deletes nothing, so the last good backups stay. Other files in `/backups`, such as manual dumps (below), are never deleted.
- **Daily clean-up:** `maintenance.daily` runs at 04:00 and deletes expired sessions, expired import previews and `llm_call` rows older than 180 days.
- **What a backup contains:** everything in the database, including the Google tokens in encrypted form. Without the same `TOKEN_ENCRYPTION_KEY` they cannot be decrypted and Gmail must be reconnected, so keep that key in your password manager (deploy.md). Treat a dump like a secret.
- **Where it lives:** on the same host as the database. A host loss loses both. Off-server copies are an open question (OQ-3); until it is answered, copy a dump off the server yourself now and then (see _Copy a backup out_).

### Check that backups are running

1. Coolify, the resource, service `worker`, _Terminal_: `ls -l /backups`. There should be one file per day for the last `BACKUP_RETENTION_DAYS` days, each with a sensible size.
2. Check a file is readable: `pg_restore -l /backups/<backup-file> | head`.

### Run a manual backup

From the `worker` _Terminal_ (it has the Postgres client and the volume):

```sh
pg_dump -Fc -f /backups/offerbound-manual-<yyyy-mm-dd>.dump "$DATABASE_URL"
```

The `offerbound-manual-` prefix keeps the file out of the retention clean-up; delete it yourself when you no longer need it. The URL appears in the container's process list while the command runs, which is acceptable inside your own container; do not paste it anywhere else.

### Copy a backup out

On the server, with `<backups-volume>` from `docker volume ls` (the name ends in `backups`):

```sh
docker run --rm -v <backups-volume>:/backups:ro alpine cat /backups/<backup-file> > <backup-file>
```

Then copy it to storage you control (`scp`, object storage, an encrypted drive). Do not put it in the repository or in a shared folder.

## Restore

Use this to recover from data loss or a bad deploy, or to move to a new server. It replaces the current database contents with the backup.

1. In Coolify, stop the `worker` service, then the `api` service. Leave `db` running. This stops jobs and sessions from writing during the restore.
2. Pick the dump: `ls -l /backups` in a terminal that has the volume, or `docker run --rm -v <backups-volume>:/backups:ro alpine ls -l /backups` on the server.
3. Restore, on the server, streaming the file into the `db` container (which has `pg_restore` and trusts local connections):

   ```sh
   docker run --rm -v <backups-volume>:/backups:ro alpine cat /backups/<backup-file> \
     | docker exec -i <db-container> pg_restore --clean --if-exists --no-owner -U offerbound -d offerbound
   ```

   This is `pg_restore --clean --if-exists -d "$DATABASE_URL" <file>` from TECHNICAL_SPEC section 16. You can run that exact form instead from any container that has both the client and the dump, for example a one-off container started from the `worker` image with the `backups` volume mounted. Warnings about objects that do not exist are expected with `--clean --if-exists` on a fresh database; errors are not.
4. Start `api`, then `worker`. The api applies any migration the dump is older than, and the worker resumes its schedules.
5. Check: sign in, open _Today_, and confirm the latest application is there. In the `worker` logs, a `gmail.sync` run should finish without errors. If Gmail shows _Reconnect_, the `TOKEN_ENCRYPTION_KEY` differs from the one the dump was made with; set the old key, or reconnect Gmail.

To rehearse a restore without touching production, create an empty database in a throwaway Postgres 17 and restore into it with the same `pg_restore` command (without `--clean`).

## Incident playbook (SECURITY section 13)

Work through the section that matches. Tick each box as you go.

### Suspected compromise of the private instance

- [ ] Revoke Offerbound in the Google Account, _Third-party connections_.
- [ ] Rotate the Google OAuth client secret in Google Cloud and in Coolify.
- [ ] Rotate `TOKEN_ENCRYPTION_KEY` in Coolify (stored Google tokens become unreadable, which is intended).
- [ ] Rotate the OpenAI key: create a new one, set it in Coolify, revoke the old one.
- [ ] Invalidate every session: in the `db` _Terminal_, `psql -U offerbound -d offerbound -c "DELETE FROM session"`.
- [ ] Redeploy, sign in again and reconnect Gmail.
- [ ] Review the Coolify and Google account sign-in history. Treat existing backups as exposed and delete those you do not need.

### OpenAI key leaked

- [ ] Revoke the key in the OpenAI project.
- [ ] Create a new key and set `OPENAI_API_KEY` in Coolify.
- [ ] Redeploy.
- [ ] Look at _Settings, AI usage_ for calls you did not make.

### Personal data found in the repository

- [ ] Remove the data from the working tree.
- [ ] Rewrite history with `git filter-repo` and force-push (the owner decides when).
- [ ] Rotate anything secret the data contained.
- [ ] Ask the code host to clear cached views if the repository is public.

### Demo abused

- [ ] Lower the rate limits, or stop the demo resource in Coolify.
- [ ] Reset the demo data (it also resets hourly).
