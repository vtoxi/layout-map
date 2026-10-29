#!/usr/bin/env bash
# Run ON the Raspberry Pi (as a user with sudo), from the unpacked project dir
# or after rsync into /opt/apartment15.
#
#   cd /opt/apartment15 && sudo bash deploy/pi/install-on-pi.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/opt/apartment15}"
ENV_SRC="${ENV_SRC:-$ROOT/deploy/pi/apartment15.env}"
ENV_DST="${ENV_DST:-/etc/apartment15.env}"
SERVICE_SRC="$ROOT/deploy/pi/apartment15.service"

echo "→ Install dir: $INSTALL_DIR"
echo "→ Project root: $ROOT"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Re-run with sudo." >&2
  exit 1
fi

# Node 20+
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0])>=18?0:1)'; then
  echo "→ Installing Node.js 20…"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  else
    echo "Install Node.js 18+ manually, then re-run." >&2
    exit 1
  fi
fi
echo "→ Node $(node -v) at $(command -v node)"

# Sync files into /opt/apartment15 if we are not already there
if [[ "$ROOT" != "$INSTALL_DIR" ]]; then
  mkdir -p "$INSTALL_DIR"
  rsync -a --delete \
    --exclude '.git/' \
    --exclude 'node_modules/' \
    --exclude '.deploy.env' \
    --exclude 'deploy/pi/apartment15.env' \
    "$ROOT"/ "$INSTALL_DIR"/
  # Keep secrets out of rsync delete; copy env separately
fi

# Environment for Pi (localhost openHAB)
if [[ -f "$ENV_SRC" ]]; then
  cp "$ENV_SRC" "$ENV_DST"
else
  cp "$INSTALL_DIR/deploy/pi/apartment15.env.example" "$ENV_DST"
fi

# Force Pi-local URLs regardless of Mac testing values
python3 - <<'PY' "$ENV_DST" || true
import sys, re
path = sys.argv[1]
text = open(path).read()
def set_kv(text, key, val):
    if re.search(rf'^{re.escape(key)}=', text, re.M):
        return re.sub(rf'^{re.escape(key)}=.*$', f'{key}={val}', text, count=1, flags=re.M)
    return text.rstrip() + f'\n{key}={val}\n'
text = set_kv(text, 'PORT', '8765')
text = set_kv(text, 'A15_PUBLIC_URL', 'http://192.168.1.100:8765')
text = set_kv(text, 'A15_OPENHAB_URL', 'http://127.0.0.1:8080')
text = set_kv(text, 'A15_FRAME_ANCESTORS', '"http://192.168.1.100:8080 http://127.0.0.1:8080"')
open(path, 'w').write(text)
print('env rewritten for Pi')
PY
chmod 600 "$ENV_DST"

# Prefer openhab user; fall back to openhabian
RUN_USER=openhab
RUN_GROUP=openhab
if ! id openhab >/dev/null 2>&1; then
  RUN_USER=openhabian
  RUN_GROUP=openhabian
fi
if ! id "$RUN_USER" >/dev/null 2>&1; then
  useradd --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin apartment15 || true
  RUN_USER=apartment15
  RUN_GROUP=apartment15
fi

chown -R "$RUN_USER:$RUN_GROUP" "$INSTALL_DIR"
# Writable data/models for saves
mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/models" "$INSTALL_DIR/assets"
chown -R "$RUN_USER:$RUN_GROUP" "$INSTALL_DIR/data" "$INSTALL_DIR/models" "$INSTALL_DIR/assets"

NODE_BIN="$(command -v node)"
sed \
  -e "s|^User=.*|User=$RUN_USER|" \
  -e "s|^Group=.*|Group=$RUN_GROUP|" \
  -e "s|^ExecStart=.*|ExecStart=$NODE_BIN $INSTALL_DIR/server.mjs|" \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=$INSTALL_DIR|" \
  "$SERVICE_SRC" > /etc/systemd/system/apartment15.service

systemctl daemon-reload
systemctl enable apartment15
systemctl restart apartment15
sleep 1
systemctl --no-pager --full status apartment15 || true

echo
echo "→ Health:"
curl -sS "http://127.0.0.1:8765/api/health" || true
echo
curl -sS "http://127.0.0.1:8765/api/openhab/status" || true
echo
echo "CAD:     http://192.168.1.100:8765/"
echo "3D:      http://192.168.1.100:8765/preview3d.html?model=mdl_b446edcaf7&view=1"
echo "openHAB: http://192.168.1.100:8080/page/apartment15_map"
