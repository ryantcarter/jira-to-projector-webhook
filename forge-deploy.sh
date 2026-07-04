#!/usr/bin/env bash
# Paste the body of this file into Forge → Site → Deployment Script.
# Forge runs it as the `forge` user from $FORGE_SITE_PATH.

set -euo pipefail

cd "$FORGE_SITE_PATH"

git pull origin "$FORGE_SITE_BRANCH"

npm ci --omit=dev --no-audit --no-fund

mkdir -p logs

# Reload if already running, otherwise start. --update-env re-reads .env.
if pm2 describe jira-to-projector >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs --update-env
  pm2 save
fi
