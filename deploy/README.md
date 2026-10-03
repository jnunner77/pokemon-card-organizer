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

1. **Get the code and set a password.**

   ```bash
   cd ~
   git clone https://github.com/jnunner77/pokemon-card-organizer.git
   cd pokemon-card-organizer
   cp deploy/.env.example .env
   nano .env        # set BINDER_PASSWORD (long), check TZ and PRICE_UPDATE_HOUR
   ```

2. **Start it on Boards' network** (Boards must be running):

   ```bash
   docker compose -f docker-compose.yml -f deploy/with-boards.yml up -d --build
   docker compose ps    # binder should become "healthy"
   ```

3. **Give it an address.** Add this block to the end of `~/agile-development-operations/deploy/Caddyfile`,
   then reload Caddy with `cd ~/agile-development-operations && docker compose restart caddy`:

   ```
   binder.{$DOMAIN} {
   	request_body {
   		max_size 60MB
   	}
   	@compressible not path /api/events
   	encode @compressible zstd gzip
   	reverse_proxy binder:4100
   	header {
   		Strict-Transport-Security "max-age=63072000"
   		X-Content-Type-Options "nosniff"
   		-Server
   	}
   }
   ```

4. **Open `https://binder.nunner.duckdns.org`**, sign in, and load your collection:
   **Settings → Restore from backup** (or **Restore from a backup** on the empty first page),
   choosing the backup file exported from the artifact. Then **Settings → Update all prices now**
   (about 5 minutes for 120 cards) or wait for the morning run.

5. **Back it up nightly** (archives in `~/binder-backups`, newest 14 kept):

   ```bash
   ( crontab -l; echo "0 3 * * * cd $HOME/pokemon-card-organizer && deploy/backup.sh >> $HOME/binder-backup.log 2>&1" ) | crontab -
   ```

**Upgrading:** `cd ~/pokemon-card-organizer && git pull && docker compose -f docker-compose.yml -f deploy/with-boards.yml up -d --build`.

**Logs:** `docker compose logs -f binder` (the daily update logs a line per problem).

## On a server of its own

Point a host name at the server, open ports 80 and 443, then:

```bash
cp deploy/.env.example .env   # set BINDER_PASSWORD and DOMAIN
docker compose --profile caddy up -d --build
```

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `BINDER_PASSWORD` | _(required in Docker)_ | The ledger's password. Changing it signs every browser out. |
| `TZ` | `America/Vancouver` | Time zone for "today" in the price log and for the daily run |
| `PRICE_UPDATE_HOUR` | `5` | The daily update starts after this hour (it catches up if the server was off) |
| `PRICE_UPDATES` | `on` | `off` turns automatic prices and images off |
| `DOMAIN` | | Host name, only with `--profile caddy` |
| `BOARDS_NETWORK` | `agile-development-operations_default` | Boards' Docker network, only with `deploy/with-boards.yml` |
