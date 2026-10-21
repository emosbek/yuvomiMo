#!/usr/bin/env bash
# Install Yuvomi and the Homey gateway on the Raspberry Pi that can see Homey.
# Run it on the Pi, not from Cursor Cloud:
#   curl -fsSL https://raw.githubusercontent.com/emosbek/yuvomiMo/cursor/homey-module-a566/modules/homey/install-pi.sh | sudo bash
set -euo pipefail

REPO="${YUVOMI_REPO:-https://github.com/emosbek/yuvomiMo.git}"
BRANCH="${YUVOMI_BRANCH:-cursor/homey-module-a566}"
DEST="${YUVOMI_DIR:-/opt/yuvomi}"
HOST="${YUVOMI_HOST:-192.168.1.24}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Kjør skriptet med sudo på Raspberry Pi-en." >&2
  exit 1
fi

arch="$(uname -m)"
case "$arch" in
  aarch64|arm64|x86_64) ;;
  *)
    echo "Denne maskinen er ${arch}. Yuvomi-imaget finnes for arm64 og amd64." >&2
    exit 1
    ;;
esac

if ! hostname -I | tr ' ' '\n' | grep -qx "$HOST"; then
  echo "Adressen ${HOST} ligger ikke på denne maskinen." >&2
  echo "Kjør skriptet på Pi-en, eller sett YUVOMI_HOST til adressen den faktisk har." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1; then
  apt-get update
  apt-get install -y git curl openssl ca-certificates
fi

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

if [ ! -d "${DEST}/.git" ]; then
  rm -rf "$DEST"
  git clone --branch "$BRANCH" --depth 1 "$REPO" "$DEST"
else
  git -C "$DEST" fetch --depth 1 origin "$BRANCH"
  git -C "$DEST" checkout -B "$BRANCH" FETCH_HEAD
fi

mkdir -p "${DEST}/data/homey" "${DEST}/backups" "${DEST}/documents"

if [ ! -f "${DEST}/.env" ]; then
  umask 077
  cat > "${DEST}/.env" <<EOF
SESSION_SECRET=$(openssl rand -hex 32)
DB_ENCRYPTION_KEY=$(openssl rand -hex 32)
BASE_URL=http://${HOST}:3000
SESSION_SECURE=false
TRUST_PROXY=loopback
NODE_ENV=production
EOF
  chmod 600 "${DEST}/.env"
  echo "Ny ${DEST}/.env. Ta vare på filen. Databasen kan ikke åpnes uten nøkkelen i den."
fi

# The gateway loads its code once, at start. A later git checkout does not
# reach the running process, so an update has to recreate the container.
docker compose -f "${DEST}/modules/homey/compose.yml" up -d --pull always --remove-orphans --force-recreate

ok=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:3000/health" >/dev/null; then
    ok=1
    break
  fi
  sleep 2
done

if [ "$ok" -ne 1 ]; then
  echo "Containerne er startet, men http://127.0.0.1:3000/health svarte ikke ennå." >&2
  echo "Logg: docker compose -f ${DEST}/modules/homey/compose.yml logs" >&2
  exit 1
fi

echo "Yuvomi kjører på http://${HOST}:3000"
echo "Åpne den adressen, lag en administrator, og lim inn Homey-adressen i modulen."
