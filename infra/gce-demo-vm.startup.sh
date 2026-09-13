#!/usr/bin/env bash
# ARCHIVED — the demo VM this booted no longer exists. Reference only.
#
# This was the `startup-script` metadata on the GCE instance `memoturn-demo`
# (GCP project Memoturn / project-e75a31d0-752f-4c2d-af2, us-central1-a,
# e2-custom-medium-4608, 50G pd-balanced, static IP 34.70.119.139) which served
# demo.memoturn.com. Created 2026-08-31, deleted 2026-09-13 along with its
# static IP and the memoturn-demo-web firewall rule.
#
# State at deletion: the instance was RUNNING but nothing listened on 80 or 443
# (only 22), so the compose stack was down. The cause was never diagnosed — the
# likeliest candidate is step 4, which writes RESEND_API_KEY empty and requires a
# key to be pasted in by hand, with magic-link the only way into the demo.
#
# Kept because it is the only record of the box's topology, and because step 5
# writes auto-deploy.sh — the poll-origin/main-and-rebuild script that by design
# existed nowhere but on the instance. The compose paths it builds
# (infra/docker-compose.prod{,.postgres}.yml) are still current.
# memoturn demo VM bootstrap — runs as root on every boot; all steps idempotent.
set -uo pipefail
exec > >(tee -a /var/log/memoturn-bootstrap.log) 2>&1
echo "=== memoturn bootstrap $(date -Is) ==="

APP_DIR=/opt/memoturn
DOMAIN=demo.memoturn.com

# --- 1. Docker -----------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "--- installing docker ---"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y && apt-get install -y curl git ca-certificates
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

# --- 2. Swap (4G) — belt-and-suspenders for cold-cache BuildKit peaks -----------
if [ ! -f /swapfile ]; then
  echo "--- creating 4G swapfile ---"
  fallocate -l 4G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=4096
  chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- 3. Repo -------------------------------------------------------------------
if [ ! -d "$APP_DIR/.git" ]; then
  echo "--- cloning repo ---"
  git clone --depth 50 https://github.com/memoturn/memoturn.git "$APP_DIR"
fi
cd "$APP_DIR" || exit 1
git fetch --depth 50 origin main && git reset --hard origin/main

# --- 4. .env — secrets generated HERE, never transported ------------------------
if [ ! -f "$APP_DIR/.env" ]; then
  echo "--- generating .env ---"
  umask 077
  cat > "$APP_DIR/.env" <<ENV
MEMOTURN_DOMAIN=${DOMAIN}
ACME_EMAIL=blake.bauman@gmail.com

POSTGRES_PASSWORD=$(openssl rand -base64 36 | tr -d '\n/+=' | head -c 40)
BLOB_SECRET_ACCESS_KEY=$(openssl rand -base64 36 | tr -d '\n/+=' | head -c 40)
BETTER_AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')
ENCRYPTION_KEY=$(openssl rand -base64 48 | tr -d '\n')

# --- email transport: REQUIRED for magic-link sign-in (the only way into the demo).
# Paste a Resend send-only restricted key here, then:
#   docker compose -f infra/docker-compose.prod.yml -f infra/docker-compose.prod.postgres.yml \\
#     --env-file .env up -d --force-recreate api worker
EMAIL_FROM=memoturn <hello@memoturn.com>
RESEND_API_KEY=

# --- public demo
DEMO_MODE=true
DEMO_TTL_DAYS=7
DEMO_MAX_SANDBOXES=500
DEMO_SEED_DAYS=30
DEMO_SEED_TRACES_PER_DAY=1000
DEMO_FINALIZE_DELAY_MS=120000
DEMO_START_RATE_LIMIT_PER_MINUTE=10

# --- analytics (GA4, same property as the public sites)
VITE_GA_MEASUREMENT_ID=G-ZQNP9F30CR
ENV
  chmod 600 "$APP_DIR/.env"
fi

# --- 5. auto-deploy script (NOT in the repo — lives only on the box) -------------
cat > "$APP_DIR/auto-deploy.sh" <<'DEPLOY'
#!/usr/bin/env bash
# Poll origin/main; rebuild the stack when it moves. Invoked by memoturn-deploy.timer.
set -uo pipefail
cd /opt/memoturn || exit 1
COMPOSE="docker compose -f infra/docker-compose.prod.yml -f infra/docker-compose.prod.postgres.yml --env-file .env"

git fetch --depth 50 origin main || exit 1
LOCAL=$(git rev-parse HEAD); REMOTE=$(git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] && exit 0

echo "=== deploy $(date -Is): $LOCAL -> $REMOTE ==="
CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE")
git reset --hard origin/main || exit 1

$COMPOSE up -d --build || exit 1

# GOTCHA: infra/Caddyfile is a SINGLE-FILE bind mount. `git reset --hard` replaces the
# inode, so the running container keeps serving the OLD config. Force-recreate caddy
# whenever the deploy touched it.
if grep -q '^infra/Caddyfile$' <<<"$CHANGED"; then
  echo "--- Caddyfile changed: force-recreating caddy (bind-mount inode swap) ---"
  $COMPOSE up -d --force-recreate caddy
fi
echo "=== deploy done $(date -Is) ==="
DEPLOY
chmod +x "$APP_DIR/auto-deploy.sh"

# --- 6. systemd continuous deploy ------------------------------------------------
cat > /etc/systemd/system/memoturn-deploy.service <<'UNIT'
[Unit]
Description=memoturn demo: deploy origin/main if it moved
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=/opt/memoturn
ExecStart=/opt/memoturn/auto-deploy.sh
TimeoutStartSec=1800
UNIT

cat > /etc/systemd/system/memoturn-deploy.timer <<'UNIT'
[Unit]
Description=memoturn demo: poll origin/main every 3 min

[Timer]
OnBootSec=10min
OnUnitActiveSec=3min
Unit=memoturn-deploy.service

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable memoturn-deploy.timer

# --- 7. Bring the stack up --------------------------------------------------------
echo "--- docker compose up (this builds; expect ~10-15 min cold) ---"
cd "$APP_DIR" || exit 1
docker compose -f infra/docker-compose.prod.yml \
               -f infra/docker-compose.prod.postgres.yml \
               --env-file .env up -d --build
RC=$?
echo "--- compose exit=$RC ---"
docker compose -f infra/docker-compose.prod.yml -f infra/docker-compose.prod.postgres.yml --env-file .env ps

systemctl start memoturn-deploy.timer
echo "=== memoturn bootstrap COMPLETE rc=$RC $(date -Is) ==="
touch /var/log/memoturn-bootstrap.done

