# Hosting the ledger for free

## Recommended: on the Boards server, at its own address

You already run [Boards](https://github.com/jnunner77/agile-development-operations) on a free
Google Cloud e2-micro VM at `nunner.duckdns.org`. The ledger runs best right next to it:

- **It costs nothing more.** The e2-micro, its 30 GB disk and DuckDNS are already free, and
  the ledger needs about 100 MB of memory and a few hundred MB of disk (photos included).
- **It has what the daily update needs**: a server that is always on, a disk that keeps the
  ledger and photos, and outbound internet access to PriceCharting, TCGplayer and the Bank of Canada.
- **No new accounts or DNS.** DuckDNS answers for any name under yours, so
  `binder.nunner.duckdns.org` already points at the VM; Boards' Caddy gets its certificate.
- **Separate from Boards.** Its own address, its own password, its own data volume and its
  own repository; Boards only gains one block in its Caddyfile.

Free alternatives considered:

| Option | Why not first choice |
| --- | --- |
| Cloudflare Workers + D1 + R2 (free) | Scheduled jobs and storage are free, but the server would have to be rewritten for Workers, and it needs a Cloudflare account and deploy token. A good second choice. |
| Oracle Cloud Always Free VM | Generous, but a new account with card verification, and capacity is often unavailable. |
| Render / Railway / Fly.io free tiers | Free web services sleep or have no lasting disk, so the daily job and photos don't survive. |
| GitHub Pages + Actions | Can run a daily job, but can't save the edits you make in the app. |
| Leave it as a claude.ai artifact | Free and signed-in, but an artifact can't run a daily job. |

Google's free tier includes 1 GB of outbound traffic a month. Card pictures are about
150 KB each and browsers keep them, so normal use stays well inside it.

### Steps

On the VM (`gcloud compute ssh boards --zone=us-central1-a --tunnel-through-iap`):

1. **Get the code and set the first password.**

   ```bash
   cd ~
   git clone https://github.com/jnunner77/pokemon-card-organizer.git
   cd pokemon-card-organizer
   cp deploy/.env.example .env
   nano .env        # set BINDER_PASSWORD (long; only used to create "admin"), check TZ
   ```

2. **Start it on Boards' network** (Boards must be running):

   ```bash
   docker compose -f docker-compose.yml -f deploy/with-boards.yml up -d --build
   docker compose ps    # binder should become "healthy"
   ```

3. **Give it an address.** Boards' Caddyfile serves `binder.{$DOMAIN}` once
   [Boards PR #6](https://github.com/jnunner77/agile-development-operations/pull/6) is merged
   (it adds the block below with Boards' protections: body limit, allowed methods, scanner
   blocking, security headers). Then reload Caddy:
   `cd ~/agile-development-operations && git pull && docker compose restart caddy`.

   ```
   binder.{$DOMAIN} {
   	import protect
   	reverse_proxy binder:4100
   }
   ```

4. **Open `https://binder.nunner.duckdns.org` and sign in** as `admin` with the
   `BINDER_PASSWORD` from step 1. Then, under **Settings → Administration**:
   - **People:** add yourself as an administrator (and anyone else as editor or viewer), sign
     in as yourself, and deactivate `admin` or give it a new password. Remove `BINDER_PASSWORD`
     from `.env`; the **Overview** warns until it no longer works.
   - **Overview:** every check should be *Passing* or a *Note*; anything else says what to do.

   Load your collection with **Settings → Restore from backup** (or **Restore from a backup** on
   the empty first page), choosing the backup file exported from the artifact. Then
   **Administration → Prices → Update all prices now** (about 5 minutes for 120 cards), or wait
   for the morning run.

   *No `BINDER_PASSWORD`?* The first visit shows a setup form instead; it needs the one-time
   code printed by `docker compose logs binder`.

5. **Back it up nightly** (archives in `~/binder-backups`, newest 14 kept):

   ```bash
   ( crontab -l; echo "0 3 * * * cd $HOME/pokemon-card-organizer && deploy/backup.sh >> $HOME/binder-backup.log 2>&1" ) | crontab -
   ```

**Upgrading:** `cd ~/pokemon-card-organizer && git pull && docker compose -f docker-compose.yml -f deploy/with-boards.yml up -d --build`.

**Logs:** *Administration → Logs* (filter by level and category, download a day's file), or
`docker compose logs -f binder`. Files are kept in the data volume under `logs/` for two weeks.

## On a server of its own

Point a host name at the server, open ports 80 and 443, then:

```bash
cp deploy/.env.example .env   # set BINDER_PASSWORD and DOMAIN
docker compose --profile caddy up -d --build
```

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `BINDER_PASSWORD` | | Creates the first administrator, `admin`, on the very first start only |
| `SECURITY_ALLOWLIST` | | Comma-separated IPs or IPv4 ranges never rate limited or blocked |
| `AUTH` | | `off` turns sign-in off entirely: only for running on your own computer |
| `TZ` | `America/Vancouver` | Time zone for "today" in the price log and for the daily run |
| `PRICE_UPDATE_HOUR` | `5` | Starting hour for the daily update (then set under Administration → Prices) |
| `PRICE_UPDATES` | `on` | `off` starts with the daily update turned off (Administration → Prices turns it on) |
| `DOMAIN` | | Host name, only with `--profile caddy` |
| `BOARDS_NETWORK` | `agile-development-operations_default` | Boards' Docker network, only with `deploy/with-boards.yml` |
