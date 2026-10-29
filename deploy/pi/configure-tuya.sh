#!/usr/bin/env bash
# Create / update openHAB Tuya Cloud Project thing from deploy/pi/tuya.env
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENVF="$ROOT/deploy/pi/tuya.env"
OH_ENV="$ROOT/deploy/pi/apartment15.env"
OH_HOST="${OH_HOST:-192.168.1.100}"

set -a
# shellcheck disable=SC1090
source "$ENVF"
# shellcheck disable=SC1090
source "$OH_ENV"
set +a

if [[ -z "${TUYA_APP_USERNAME:-}" || -z "${TUYA_APP_PASSWORD:-}" ]]; then
  echo "Set TUYA_APP_USERNAME and TUYA_APP_PASSWORD in deploy/pi/tuya.env" >&2
  echo "(Smart Life / Tuya Smart app login — not the developer portal.)" >&2
  exit 1
fi

TOKEN="${A15_OPENHAB_TOKEN:?missing A15_OPENHAB_TOKEN in apartment15.env}"
THING_UID="tuya:project:apartment15"

BODY=$(python3 - <<PY
import json, os
print(json.dumps({
  "UID": "${THING_UID}",
  "thingTypeUID": "tuya:project",
  "label": "Tuya Cloud · Apartment15 (India)",
  "configuration": {
    "username": os.environ["TUYA_APP_USERNAME"],
    "password": os.environ["TUYA_APP_PASSWORD"],
    "accessId": os.environ["TUYA_ACCESS_ID"],
    "accessSecret": os.environ["TUYA_ACCESS_SECRET"],
    "countryCode": int(os.environ.get("TUYA_COUNTRY_CODE") or "91"),
    "schema": os.environ.get("TUYA_APP_SCHEMA") or "smartLife",
    "dataCenter": os.environ.get("TUYA_DATA_CENTER") or "https://openapi.tuyain.com",
  }
}))
PY
)

CODE=$(curl -sS -o /tmp/tuya_thing.json -w "%{http_code}" -u "${TOKEN}:" \
  -H "Content-Type: application/json" -H "Accept: application/json" \
  -X PUT "http://${OH_HOST}:8080/rest/things/${THING_UID}" \
  -d "$BODY")
if [[ "$CODE" == "404" ]]; then
  CODE=$(curl -sS -o /tmp/tuya_thing.json -w "%{http_code}" -u "${TOKEN}:" \
    -H "Content-Type: application/json" -H "Accept: application/json" \
    -X POST "http://${OH_HOST}:8080/rest/things" \
    -d "$BODY")
fi

echo "HTTP $CODE"
python3 - <<'PY'
import json
t=json.load(open("/tmp/tuya_thing.json"))
if "error" in t:
  print(t)
else:
  print("UID:", t.get("UID"))
  print("status:", t.get("statusInfo"))
  print("label:", t.get("label"))
PY
echo
echo "Next: MainUI → Settings → Things → Inbox (scan for Tuya devices)"
echo "Portal: iot.tuya.com → Devices → Link Tuya App Account (must be done once)"
