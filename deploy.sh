#!/usr/bin/env bash
# Deploy apartment15-map to Windows/Plesk hosting via FTP.
# Usage:
#   ./deploy.sh
# Credentials: copy .deploy.env.example → .deploy.env (gitignored), or export vars.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ -f "$ROOT/.deploy.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  source "$ROOT/.deploy.env"
  set +a
fi

FTP_HOST="${FTP_HOST:?Set FTP_HOST in .deploy.env or the environment}"
FTP_USER="${FTP_USER:?Set FTP_USER in .deploy.env or the environment}"
FTP_PASS="${FTP_PASS:?Set FTP_PASS in .deploy.env or the environment}"
FTP_REMOTE_DIR="${FTP_REMOTE_DIR:?Set FTP_REMOTE_DIR in .deploy.env or the environment}"
SITE_URL="${SITE_URL:-}"

if ! command -v lftp >/dev/null 2>&1; then
  echo "error: lftp is required (brew install lftp)" >&2
  exit 1
fi

echo "→ Uploading to ftp://${FTP_HOST}/${FTP_REMOTE_DIR}/"

# Windows FTP rejects SITE CHMOD; disable permission sync.
lftp -c "
set ssl:verify-certificate no;
set ftp:passive-mode on;
set ftp:list-options -a;
set mirror:set-permissions no;
set net:timeout 60;
set net:max-retries 3;
set cmd:fail-exit yes;
open -u '${FTP_USER}','${FTP_PASS}' ftp://${FTP_HOST};
cd ${FTP_REMOTE_DIR};
mirror -R --verbose --parallel=4 \
  --exclude-glob .git/ \
  --exclude-glob .gitignore \
  --exclude-glob .deploy.env \
  --exclude-glob .deploy.env.example \
  --exclude-glob deploy.sh \
  --exclude-glob server.mjs \
  --exclude-glob zip-util.mjs \
  --exclude-glob data/ \
  --exclude-glob '*.md' \
  --exclude-glob .DS_Store \
  --exclude-glob phpprobe.php \
  ${ROOT}/ .;
bye
"

echo "→ Smoke checks (${SITE_URL})"
fail=0
for path in "/" "/api/health" "/api/models" "/api/auth/me" "/preview3d.html" "/view.html"; do
  code="$(curl -sk -o /dev/null -w '%{http_code}' --connect-timeout 20 "${SITE_URL}${path}" || true)"
  # auth/me is 401 without a session; models may be 401 when A15_AUTH=1
  if [[ "$code" == "200" || "$code" == "401" ]]; then
    echo "  OK  ${path} (${code})"
  else
    echo "  FAIL ${path} (${code:-unreachable})"
    fail=1
  fi
done

# Exclude server data + local secrets from upload
# (data/ stays on server; recreate via API)
if [[ "$fail" -ne 0 ]]; then
  echo "Deploy uploaded, but smoke checks failed (DNS/TLS may still be propagating)." >&2
  exit 1
fi

echo "Deployed → ${SITE_URL}"
