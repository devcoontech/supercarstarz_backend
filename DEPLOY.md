# Deploying Supercarstars

There are two ways to run this on a server. **Use one, not both**, because each needs ports 80 and 443.

- **Coolify (the current setup):** manage and redeploy from a web UI. See the next section. Don't use `docker-compose.prod.yml` or `deploy/` with it.
- **Plain Docker Compose:** `docker-compose.prod.yml` runs the database, API, dashboard and Caddy (automatic HTTPS). Follow steps 1 to 7 below.

The customer app is built separately with EAS (see the end of this guide).

Run the server commands as root on the VPS.

## Deploying with Coolify

Coolify deploys one repo per application, so it runs three separate resources. It also provides the proxy and HTTPS.

| Resource | Source | Port | Domain |
| --- | --- | --- | --- |
| PostgreSQL 17 | Coolify database | 5432 (private) | None |
| API | `backend` repo, Dockerfile build pack | 4000 | `https://api.supercarstars.com` |
| Dashboard | `dashboard` repo, Dockerfile build pack | 80 | `https://admin.supercarstars.com` |

Menu names can differ slightly between Coolify versions.

### Part 1: Give Coolify its own HTTPS address

1. In GoDaddy, add an A record: name `coolify`, value `193.160.119.12`, TTL 600.
2. Once `nslookup coolify.supercarstars.com` shows the server's address, open **Settings > General** in Coolify.
3. Set **URL** to `https://coolify.supercarstars.com` and save.
4. Open that address and sign in. Use it from now on, so your password is encrypted.

### Part 2: Create the project and connect GitHub

1. Go to **Projects** and create one named `Supercarstars`, using the `production` environment.
2. Go to **Sources > New source > GitHub App** and give it a name.
3. Under automated installation, set the webhook endpoint to `https://coolify.supercarstars.com`, then choose **Register with GitHub**.
4. Create the app, choose **Install repositories**, and select `supercarstarz_backend` and `supercarstarz_dashboard`.

### Part 3: Create the database

1. In the project, choose **+ New**, then **PostgreSQL**.
2. **Select PostgreSQL 17 (`postgres:17-alpine`)**. Coolify defaults to 18, but the data move was rehearsed on 17.
3. Name it `supercars-db`, start it, and leave any public port setting off.
4. On its **General** page, copy **Postgres URL (internal)**. You'll use it as `DATABASE_URL` next.

### Part 4: Deploy the API

1. In the project, choose **+ New > Private Repository (with GitHub App)**, then choose this server, your GitHub App and `supercarstarz_backend`, then **Load Repository**.
2. Use these settings, and save before deploying:

| Setting | Value |
| --- | --- |
| Branch | `main` |
| Build Pack | Dockerfile |
| Base Directory | `/` |
| Dockerfile Location | `/Dockerfile` |
| Ports Exposes | `4000` |
| Ports Mappings | Leave empty, or the API skips the proxy |
| Domain | Protocol `https`, domain `api.supercarstars.com` |
| Advanced > Build > Build arguments | **Managed manually in Dockerfile** |
| Advanced > Deployment > Auto deploy | Deploy on push (webhooks) |

The build-arguments setting matters because variables are available during builds by default, which can store secrets in the image's metadata.

3. Under **Persistent Storage**, add two **Volume Mounts**. Without them, every deploy loses uploaded files.

| Name | Destination path |
| --- | --- |
| `supercars-uploads` | `/app/uploads` |
| `supercars-private-uploads` | `/app/private-uploads` |

4. Under **Environment Variables**, add these. Generate each secret with `openssl rand -hex 32`. If you see **Available during build** on a variable, turn it off.

```ini
NODE_ENV=production
PORT=4000
DATABASE_URL=<Postgres URL (internal) from Part 3>
DATABASE_SSL=false
JWT_SECRET=<generated value>
SETTINGS_ENCRYPTION_KEY=<copy exactly from your local backend/.env>
CORS_ORIGINS=https://admin.supercarstars.com
TRUST_PROXY=1
PUBLIC_API_URL=https://api.supercarstars.com
UPLOAD_DIR=/app/uploads
PRIVATE_UPLOAD_DIR=/app/private-uploads
```

Keep `SETTINGS_ENCRYPTION_KEY` the same as your local one, or your saved Stripe and email secrets won't decrypt. Don't add any `SUPABASE_*` variables, or uploads will keep going to Supabase.

5. Leave Coolify's **Healthcheck** page alone. The image has its own check, which Coolify uses instead.
6. Choose **Deploy**. Migrations run automatically when the container starts. Then check it:

```bash
curl https://api.supercarstars.com/health
```

It should return `{"ok":true}`. A new certificate can take a minute or two.

### Part 5: Deploy the dashboard

1. Add another **Private Repository (with GitHub App)** resource using `supercarstarz_dashboard`.
2. Use these settings:

| Setting | Value |
| --- | --- |
| Branch | `main` |
| Build Pack | Dockerfile |
| Base Directory | `/` |
| Dockerfile Location | `/Dockerfile` |
| Ports Exposes | `80` |
| Ports Mappings | Leave empty |
| Domain | Protocol `https`, domain `admin.supercarstars.com` |

3. Add one environment variable, with **Available during build** on, because it's fixed into the dashboard when it's built:

```ini
VITE_API_URL=https://api.supercarstars.com
```

4. Choose **Deploy**, then open `https://admin.supercarstars.com`. You won't be able to sign in until Part 6.

### Part 6: Move your data from Supabase

Do this when nobody is using the Supabase system, and before customers use this one. The clear step below **wipes this new database**, so never run it after going live. Supabase isn't changed.

Run these on the server, as root. First find the two containers. Each command should print one name:

```bash
DB=$(docker ps --format '{{.Names}} {{.Image}}' | awk '/postgres:17/{print $1}'); echo "$DB"
```

```bash
API=$(docker ps --filter expose=4000 --format '{{.Names}}'); echo "$API"
```

Clear the default rows the migrations created:

```bash
docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'EOF'
DO $$
DECLARE t text;
BEGIN
  SELECT string_agg(format('public.%I', tablename), ',') INTO t
  FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations';
  EXECUTE 'TRUNCATE ' || t || ' CASCADE';
END $$;
EOF
```

Paste `DATABASE_URL` from your local `backend/.env` when asked. The input is hidden:

```bash
read -rsp "Supabase DATABASE_URL: " SRC_DB && export SRC_DB && echo
```

Copy the data straight across, so no file containing customer data is left on the server. A warning about circular foreign keys on `booking_charges` is expected:

```bash
docker exec -e SRC_DB "$DB" sh -c 'set -o pipefail; pg_dump "$SRC_DB" --data-only --schema=public --exclude-table=public.schema_migrations -Fc | pg_restore -U postgres -d postgres --data-only --disable-triggers --no-owner --exit-on-error'; echo "copy exit: $?"
```

It must end with `copy exit: 0`. Check the counts against Supabase:

```bash
docker exec "$DB" psql -U postgres -d postgres -c "select (select count(*) from bookings) bookings, (select count(*) from vehicles) cars, (select count(*) from customers) customers, (select count(*) from payments) payments, (select count(*) from staff_users) staff"
```

Now copy the files. Paste `SUPABASE_URL`, then `SUPABASE_SERVICE_ROLE_KEY`, from your local `backend/.env`:

```bash
read -rp "Supabase URL: " SOURCE_SUPABASE_URL && export SOURCE_SUPABASE_URL
```

```bash
read -rsp "Supabase service key: " SOURCE_SUPABASE_SERVICE_ROLE_KEY && export SOURCE_SUPABASE_SERVICE_ROLE_KEY && echo
```

```bash
docker exec -e SOURCE_SUPABASE_URL -e SOURCE_SUPABASE_SERVICE_ROLE_KEY "$API" node dist/scripts/storage-to-disk.js
```

It should end with `0 failed`, and it's safe to run again. Finally, clear the secrets from your session and restart the API:

```bash
unset SRC_DB SOURCE_SUPABASE_URL SOURCE_SUPABASE_SERVICE_ROLE_KEY; docker restart "$API"
```

Keep the Supabase project for at least a week after going live.

If you aren't moving any data, skip this part and create the owner instead. Add `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD` to the API's variables and redeploy, run `node dist/scripts/seed.js` in its Terminal, then remove both variables. Never use `--demo` here.

### Part 7: Check everything and finish the settings

1. Sign in at `https://admin.supercarstars.com` with your existing owner account.
2. Open a car and a driver to check that their images and licence photos load.
3. Under **Settings, Email (SMTP)**, test the connection and send a test email.
4. In Stripe, stay in **test mode** while testing. Add the webhook `https://api.supercarstars.com/api/webhooks/stripe` with these events: `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `refund.created`, `refund.updated`.
5. Save that webhook's new signing secret in the dashboard under **Settings, Payments and Stripe**. Don't skip this, or paid bookings won't be marked as paid.
6. Set the dashboard address to `https://admin.supercarstars.com` in the business settings, so links in owner emails work. It's currently empty.
7. Check that the login limit can't be bypassed. Run this on the server. It should print `401` several times, then `429`:

```bash
for i in $(seq 1 12); do curl -s -o /dev/null -w "%{http_code} " -H 'content-type: application/json' -H "X-Forwarded-For: 9.9.9.$i" -d '{"email":"nobody@example.com","password":"wrong-password"}' https://api.supercarstars.com/api/auth/staff/login; done; echo
```

8. Check that the API can only be reached through the proxy. From your PC, this should time out:

```bash
curl -m 5 http://193.160.119.12:4000/health
```

### Part 8: Set up backups

1. **Database:** open `supercars-db`, then **Backups > + Add**. Use a frequency of `daily` and keep 14 days.
2. **Uploaded files:** open the API, then **Backups > Storage backups > Add**. Add a daily schedule for each of the two volumes.
3. **Off the server:** add S3-compatible storage under **S3 storage** and enable it on both. Otherwise the backups only live on this server, under `/data/coolify/backups` for the database. They contain customer data and licence photos, so keep them private.
4. **Test a restore:** database backups restore from the database's **Backups > Import backup**. Coolify doesn't restore file backups from its UI, so those have to be downloaded and restored by hand.

Don't run `deploy/backup.sh` on this setup, because it only works with the Compose stack.

### Part 9: Lock the server down

1. In the Hostinger firewall, remove the rules for ports `8000`, `6001` and `6002`, then check that `https://coolify.supercarstars.com` still works, including live updates and the Terminal.
2. Turn off password logins for SSH. Keep your current session open, and test from a second window before closing it:

```bash
ssh -i "$env:USERPROFILE\.ssh\supercars_vps" root@193.160.119.12
```

Only when that works, run this on the server:

```bash
echo "PasswordAuthentication no" > /etc/ssh/sshd_config.d/00-no-password.conf && sshd -t && systemctl reload ssh
```

The Hostinger **Web console** is still available if you ever get locked out.

### Part 10: Build the app for phones

The server must be live first, because the app calls `https://api.supercarstars.com`. Run these from `mobile/` on your PC.

Update the packages Expo reports as out of date, and commit the result:

```bash
npx expo install --fix
```

```bash
eas login
```

Android gives you an APK with an install link and QR code:

```bash
eas build --profile preview --platform android
```

An iPhone build needs a paid Apple Developer account, and each test phone registered first:

```bash
eas device:create
```

```bash
eas build --profile preview --platform ios
```

Test a booking with Stripe's test card `4242 4242 4242 4242`, then confirm the booking shows as paid in the dashboard.

**Before submitting to the app stores:**
- Add in-app account deletion, which both stores require for apps with sign-up.
- Publish a privacy policy page and link to it in the store listings and the app.
- Switch Stripe to live keys and a live webhook.
- Clear test bookings and customers, and replace the placeholder car photos.

Then use the store build commands under **Release to the stores** at the end of this guide.

### Part 11: Set up push notifications

Pushes go through Expo's push service, which passes them to Google (Android) and Apple (iOS). Each needs its credentials once. The backend needs no new settings.

**Android:**

1. In the [Firebase console](https://console.firebase.google.com), create a project and add an Android app with the package name `com.supercarstars.app`.
2. Download `google-services.json` into `mobile/`, add `"googleServicesFile": "./google-services.json"` under `expo.android` in `mobile/app.json`, and commit both.
3. In Firebase, open **Project settings > Service accounts > Generate new private key**. **Keep this file secret and out of git.**
4. Upload the key to Expo, choosing **Android > Google Service Account > Manage your Google Service Account Key for Push Notifications (FCM V1)**:

```bash
eas credentials --platform android
```

**iOS** needs a paid Apple Developer account. The first iOS build offers to create the push key, so answer yes. To set it up separately, choose **Push Notifications** here:

```bash
eas credentials --platform ios
```

Then make new builds of the app, because this adds native code. Pushes can't be tested in Expo Go on Android, and iOS is best tested on a real iPhone.

**To check delivery**, run this on the server. `sent` means Expo accepted the push. A `last_error` such as `InvalidCredentials` appears about 15 minutes later if Google or Apple refused it:

```bash
docker exec "$DB" psql -U postgres -d postgres -c "select created_at, title, status, attempts, last_error from push_outbox order by created_at desc limit 15"
```

### Deploying updates

Push to `main` in the `backend` or `dashboard` repo, and Coolify builds and deploys that app. Migrations run automatically. If the new version fails to start or fails its health check, Coolify can keep the old one running. `mobile` updates need a new EAS build.

### If something goes wrong

| Symptom | Likely cause |
| --- | --- |
| API build fails | Read the deployment log in Coolify. Confirm the build arguments setting in Part 4 |
| Container keeps restarting | Open its logs. A missing variable or wrong `DATABASE_URL` is the usual cause |
| `No available server` or `503` | The container isn't healthy yet, or Ports Exposes is wrong |
| Certificate error | DNS isn't pointing at the server, or port 80 is blocked |
| Dashboard shows a network or CORS error | Check `CORS_ORIGINS`. If `VITE_API_URL` changed, redeploy the dashboard |
| Stripe or email secrets fail | `SETTINGS_ENCRYPTION_KEY` doesn't match your local value |
| Images disappear after a deploy | The Persistent Storage mounts are missing |
| No push notifications arrive | Check that notifications are allowed on the phone, then see the delivery check in Part 11. No rows means the phone never registered, which on Android usually means Firebase isn't set up |

## Deploying with plain Docker Compose

Skip this section if you're using Coolify.

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
