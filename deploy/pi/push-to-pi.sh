#!/usr/bin/env bash
# Push Apartment15 from this Mac to the Pi and install as a systemd service.
#
# Usage:
#   export PI_HOST=192.168.1.100
#   export PI_USER=openhabian          # or pi
#   export PI_PASS='your-password'     # or enter when prompted (needs sshpass)
#   ./deploy/pi/push-to-pi.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PI_HOST="${PI_HOST:-192.168.1.100}"
PI_USER="${PI_USER:-openhabian}"
REMOTE_TMP="${REMOTE_TMP:-/tmp/apartment15-deploy}"
INSTALL_DIR="${INSTALL_DIR:-/opt/apartment15}"

if [[ ! -f "$ROOT/deploy/pi/apartment15.env" ]]; then
  echo "Missing deploy/pi/apartment15.env (with A15_OPENHAB_TOKEN). Copy from .example and paste token." >&2
  exit 1
fi

# Build Pi-local env (token kept; URLs forced for Pi)
ENV_PI="$(mktemp)"
cp "$ROOT/deploy/pi/apartment15.env" "$ENV_PI"
perl -pi -e 's|^A15_PUBLIC_URL=.*|A15_PUBLIC_URL=http://192.168.1.100:8765|' "$ENV_PI"
perl -pi -e 's|^A15_OPENHAB_URL=.*|A15_OPENHAB_URL=http://127.0.0.1:8080|' "$ENV_PI"
perl -pi -e 's|^A15_FRAME_ANCESTORS=.*|A15_FRAME_ANCESTORS="http://192.168.1.100:8080 http://127.0.0.1:8080"|' "$ENV_PI"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
RSYNC_RSH="ssh ${SSH_OPTS[*]}"

if [[ -n "${PI_PASS:-}" ]]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    echo "Install sshpass (brew install sshpass) or set up SSH keys." >&2
    exit 1
  fi
  export SSHPASS="$PI_PASS"
  SSH=(sshpass -e ssh "${SSH_OPTS[@]}")
  RSYNC_RSH="sshpass -e ssh ${SSH_OPTS[*]}"
else
  SSH=(ssh "${SSH_OPTS[@]}")
fi

echo "→ Checking SSH ${PI_USER}@${PI_HOST} …"
"${SSH[@]}" "${PI_USER}@${PI_HOST}" 'echo SSH_OK; uname -a; free -h | head -2'

echo "→ Syncing project to ${PI_USER}@${PI_HOST}:${REMOTE_TMP}"
"${SSH[@]}" "${PI_USER}@${PI_HOST}" "rm -rf '$REMOTE_TMP' && mkdir -p '$REMOTE_TMP'"
rsync -az --delete \
  -e "$RSYNC_RSH" \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude '.deploy.env' \
  --exclude 'deploy/pi/apartment15.env' \
  --exclude '.DS_Store' \
  "$ROOT"/ "${PI_USER}@${PI_HOST}:${REMOTE_TMP}/"

# Ship env privately
scp ${PI_PASS:+-o} ${PI_PASS:+"RemoteCommand=none"} 2>/dev/null || true
if [[ -n "${PI_PASS:-}" ]]; then
  sshpass -e scp "${SSH_OPTS[@]}" "$ENV_PI" "${PI_USER}@${PI_HOST}:${REMOTE_TMP}/deploy/pi/apartment15.env"
else
  scp "${SSH_OPTS[@]}" "$ENV_PI" "${PI_USER}@${PI_HOST}:${REMOTE_TMP}/deploy/pi/apartment15.env"
fi
rm -f "$ENV_PI"

echo "→ Running install-on-pi.sh (sudo)…"
if [[ -n "${PI_PASS:-}" ]]; then
  # Pass password to remote sudo -S (quoted safely)
  REMOTE_PASS_Q=$(printf '%q' "$PI_PASS")
  "${SSH[@]}" "${PI_USER}@${PI_HOST}" \
    "printf '%s\n' ${REMOTE_PASS_Q} | sudo -S bash '${REMOTE_TMP}/deploy/pi/install-on-pi.sh'"
else
  "${SSH[@]}" -t "${PI_USER}@${PI_HOST}" \
    "sudo bash '${REMOTE_TMP}/deploy/pi/install-on-pi.sh'"
fi

echo "→ Updating openHAB MainUI page iframe to Pi URLs…"
# Prefer local Mac curl to openHAB if reachable
TOKEN=$(grep '^A15_OPENHAB_TOKEN=' "$ROOT/deploy/pi/apartment15.env" | cut -d= -f2-)
PAGE_JSON="$ROOT/deploy/pi/apartment15-page.json"
python3 - <<'PY' "$PAGE_JSON"
import json,sys
p=json.load(open(sys.argv[1]))
# rewrite any 192.168.1.3:8765 → Pi
def walk(o):
  if isinstance(o, dict):
    for k,v in o.items():
      if k=='src' and isinstance(v,str) and ':8765' in v:
        o[k]=v.replace('http://192.168.1.3:8765','http://192.168.1.100:8765')
        if '192.168.1.100:8765' not in o[k] and o[k].startswith('http'):
          pass
      else:
        walk(v)
  elif isinstance(o, list):
    for i in o: walk(i)
walk(p)
# force known URLs
try:
  p['slots']['default'][0]['slots']['default'][0]['slots']['default'][0]['slots']['default'][0]['config']['src']=\
    'http://192.168.1.100:8765/preview3d.html?model=mdl_b446edcaf7&view=1'
  p['slots']['default'][1]['slots']['default'][0]['slots']['default'][0]['slots']['default'][0]['config']['src']=\
    'http://192.168.1.100:8765/index.html?model=mdl_b446edcaf7'
except Exception as e:
  print('warn rewrite', e)
json.dump(p, open(sys.argv[1],'w'), indent=2)
print('page json updated')
PY

curl -sS -u "${TOKEN}:" -H "Content-Type: application/json" -H "Accept: application/json" \
  -X PUT "http://${PI_HOST}:8080/rest/ui/components/ui:page/apartment15_map" \
  --data-binary @"$PAGE_JSON" >/dev/null

echo
echo "Done."
echo "  CAD:     http://${PI_HOST}:8765/"
echo "  3D:      http://${PI_HOST}:8765/preview3d.html?model=mdl_b446edcaf7&view=1"
echo "  openHAB: http://${PI_HOST}:8080/page/apartment15_map"
echo
curl -sS "http://${PI_HOST}:8765/api/openhab/status" || echo "(status pending — wait a few seconds and refresh)"
echo
