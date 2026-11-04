# Deploying Supercarstars

There are two ways to run this on a server. **Use one, not both**, because each needs ports 80 and 443.

- **Coolify (the current setup):** manage and redeploy from a web UI. See the next section. Don't use `docker-compose.prod.yml` or `deploy/` with it.
- **Plain Docker Compose:** `docker-compose.prod.yml` runs the database, API, dashboard and Caddy (automatic HTTPS). Follow steps 1 to 7 below.

The customer app is built separately with EAS (see the end of this guide).

Run the server commands as root on the VPS.

## Deploying with Coolify

Coolify deploys one repo per application, so it runs three separate resources: the database, the API and the dashboard. It also provides the proxy and HTTPS.

| Resource | Source | Port | Domain |
| --- | --- | --- | --- |
| PostgreSQL 17 | Coolify database | 5432 (private) | None |
| API | `backend` repo, Dockerfile build pack | 4000 | `https://api.supercarstars.com` |
| Dashboard | `dashboard` repo, Dockerfile build pack | 80 | `https://admin.supercarstars.com` |

Set "Ports Exposes" only. Don't add port mappings, or the service becomes reachable without going through the proxy.

**API environment variables (runtime):**

```ini
NODE_ENV=production
PORT=4000
DATABASE_URL=<internal URL from the database's General page>
DATABASE_SSL=false
JWT_SECRET=<openssl rand -hex 32>
SETTINGS_ENCRYPTION_KEY=<from your local backend/.env if moving data, otherwise openssl rand -hex 32>
CORS_ORIGINS=https://admin.supercarstars.com
TRUST_PROXY=1
PUBLIC_API_URL=https://api.supercarstars.com
UPLOAD_DIR=/app/uploads
PRIVATE_UPLOAD_DIR=/app/private-uploads
```

**API persistent storage:** add a volume mount for `/app/uploads` and one for `/app/private-uploads`. Without them, every deploy loses the uploaded files.

**API health check:** path `/health`, port 4000.

**Dashboard environment variable (available during build):** `VITE_API_URL=https://api.supercarstars.com`

**Migrations** run automatically each time the API container starts.

**Backups:** Coolify's database backups are stored on this server under `/data/coolify/backups` unless you add S3 storage. Schedule the database backup and back up both upload volumes too, then keep a copy off the server.

**Firewall:** use the Hostinger panel, because UFW may not block ports that Docker publishes. Allow 22, 80 and 443, plus 8000, 6001 and 6002 until the Coolify UI has its own domain, then close those three.

Don't run `backup.sh` on this setup, because it only works with the Compose stack.

## 1. Point the domain at the server

In GoDaddy, under your domain's DNS, add two records. Leave the nameservers and the `@` and MX records alone.

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| A | `api` | `193.160.119.12` | 600 |
| A | `admin` | `193.160.119.12` | 600 |

Wait until `nslookup api.supercarstars.com` shows the server's address before starting the stack, or HTTPS certificates can't be issued.

## 2. Prepare the server

Check that nothing else is using ports 80 or 443:

```bash
ss -tlnp
```

```bash
curl -fsSL https://get.docker.com | sh
```

```bash
apt install -y git ufw && ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443 && ufw --force enable
```

## 3. Download the code

The two repos must sit side by side, because the backend's compose file builds `../dashboard`.

```bash
mkdir -p /var/www/supercars && cd /var/www/supercars && \
  git clone https://github.com/devcoontech/supercarstarz_backend.git backend && \
  git clone https://github.com/devcoontech/supercarstarz_dashboard.git dashboard
```

## 4. Create the settings

```bash
cd /var/www/supercars/backend && cp .env.production.example .env && chmod 600 .env && nano .env
```

Generate each secret with `openssl rand -hex 32`. `COMPOSE_FILE` in this file makes a plain `docker compose` use the production stack, so every command below must be run from this folder.

## 5. Load the data

Choose one option.

### Option A: move the data from Supabase

Do this when nobody is using the app. Bookings made after the copy are not brought across. Set `SETTINGS_ENCRYPTION_KEY` in `.env` to the value from your local `backend/.env`, and leave `SEED_OWNER_*` empty.

Create the empty tables:

```bash
docker compose build && docker compose up -d --wait db && docker compose run --rm migrate
```

Paste your local `DATABASE_URL` when asked:

```bash
read -rsp "Supabase DATABASE_URL: " SRC_DB && export SRC_DB && echo
```

Copy the data out. A warning about circular foreign keys on `booking_charges` is expected.

```bash
mkdir -p /var/backups/supercars && chmod 700 /var/backups/supercars && \
  docker compose exec -T -e SRC_DB db sh -c \
  'pg_dump "$SRC_DB" --data-only --schema=public --exclude-table=public.schema_migrations -Fc' \
  > /var/backups/supercars/supabase-data.dump
```

Clear the default rows. **This wipes every table except the migration history, so only run it before going live.**

```bash
docker compose exec -T db psql -U supercars -d supercars -v ON_ERROR_STOP=1 <<'EOF'
DO $$
DECLARE t text;
BEGIN
  SELECT string_agg(format('public.%I', tablename), ',') INTO t
  FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations';
  EXECUTE 'TRUNCATE ' || t || ' CASCADE';
END $$;
EOF
```

```bash
docker compose exec -T db pg_restore -U supercars -d supercars \
  --data-only --disable-triggers --no-owner --exit-on-error \
  < /var/backups/supercars/supabase-data.dump
```

Copy the files. Paste your local `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` when asked:

```bash
read -rp "Supabase URL: " SOURCE_SUPABASE_URL && export SOURCE_SUPABASE_URL
```

```bash
read -rsp "Supabase service key: " SOURCE_SUPABASE_SERVICE_ROLE_KEY && export SOURCE_SUPABASE_SERVICE_ROLE_KEY && echo
```

```bash
docker compose run --rm -e SOURCE_SUPABASE_URL -e SOURCE_SUPABASE_SERVICE_ROLE_KEY api node dist/scripts/storage-to-disk.js
```

It should finish with `0 failed`, and it is safe to run again. Then delete the dump, which contains customer data, and clear the secrets:

```bash
rm /var/backups/supercars/supabase-data.dump && unset SRC_DB SOURCE_SUPABASE_URL SOURCE_SUPABASE_SERVICE_ROLE_KEY
```

Keep the Supabase project for at least a week after going live.

### Option B: start with an empty database

Set `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD` in `.env`. After step 6, create the owner account, then remove the password from `.env`. Never run the seed with `--demo` on this server.

```bash
docker compose exec api node dist/scripts/seed.js
```

## 6. Start everything

```bash
docker compose up -d --build --wait
```

```bash
docker compose ps
```

```bash
curl https://api.supercarstars.com/health
```

Then open `https://admin.supercarstars.com`, sign in, and check:

1. Car images and a driver's licence photo open.
2. Settings, Email (SMTP): send a test email.
3. Settings, Payments and Stripe: the keys are present.
4. In Stripe, add the webhook `https://api.supercarstars.com/api/webhooks/stripe`, then save its new signing secret in the dashboard.

## 7. Turn on nightly backups

```bash
echo "0 3 * * * root bash /var/www/supercars/backend/deploy/backup.sh" > /etc/cron.d/supercars-backup
```

```bash
bash /var/www/supercars/backend/deploy/backup.sh && ls -lh /var/backups/supercars
```

Backups stay on this server for 14 days, so copy them somewhere else as well. They contain customer data and licence photos, so keep any copies secure.

To restore the database, replace the date. To restore the files, unpack `files-*.tar.gz` back into the `supercars_uploads` and `supercars_private_uploads` volumes.

```bash
docker compose stop api
```

```bash
docker compose exec -T db pg_restore -U supercars -d supercars --clean --if-exists --no-owner < /var/backups/supercars/db-YYYY-MM-DD.dump
```

```bash
docker compose start api
```

## Deploying updates

New database migrations are applied automatically.

```bash
cd /var/www/supercars/dashboard && git pull && cd ../backend && git pull && docker compose up -d --build --wait
```

## Useful commands

```bash
docker compose logs -f api
```

```bash
docker compose restart api
```

Don't run `docker compose down -v` on this server. The `-v` flag deletes the database and all uploaded files.

## Customer app

The API address is set in `mobile/eas.json`, and the server must be live before you test. Run these from `mobile/` on your PC, signed in to the Expo account that owns the project:

```bash
eas login
```

### Test on your phones

Android: this produces an APK with an install link and QR code.

```bash
eas build --profile preview --platform android
```

iPhone: this needs a paid Apple Developer account. Register each test phone first.

```bash
eas device:create
```

```bash
eas build --profile preview --platform ios
```

### Release to the stores

```bash
eas build --profile production --platform all
```

```bash
eas submit --profile production --platform android
```

```bash
eas submit --profile production --platform ios
```

Before submitting, switch Stripe to live keys in the dashboard and replace any test records and placeholder photos.
