#!/bin/sh
# Build the browser-only bundle and rsync it to a static web host.
#
# Reads deploy.env (gitignored) in the repo root, or the environment:
#   PDFINK_DEPLOY_DEST   rsync destination, e.g. user@host:/var/www/pdfink/
#   PDFINK_DEPLOY_SSH    ssh command for rsync, default "ssh" (e.g. "ssh -p 2022")
#   PDFINK_DEPLOY_URL    optional; fetched afterwards as a smoke test
#
# The bundle has storage mode "local" baked in, so it never calls /api.
# It is written to dist-local/ so the server-mode dist/ is left alone.
set -eu
cd "$(dirname "$0")/.."
[ -f deploy.env ] && . ./deploy.env
: "${PDFINK_DEPLOY_DEST:?set PDFINK_DEPLOY_DEST in deploy.env or the environment}"
PDFINK_DEPLOY_SSH="${PDFINK_DEPLOY_SSH:-ssh}"

npx tsc --noEmit
VITE_STORAGE=local npx vite build --outDir dist-local --emptyOutDir
rsync -rlt --delete --exclude Caddyfile -e "$PDFINK_DEPLOY_SSH" dist-local/ "$PDFINK_DEPLOY_DEST"
echo "deployed to $PDFINK_DEPLOY_DEST"

if [ -n "${PDFINK_DEPLOY_URL:-}" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$PDFINK_DEPLOY_URL")
  echo "$PDFINK_DEPLOY_URL -> HTTP $code"
  [ "$code" = 200 ]
fi
