#!/usr/bin/env bash
#
# Provision the Omni Code Launcher cloud environment from main.bicep:
# infra + EasyAuth (AAD), import the prebuilt images, start the Web App.
#
# Usage:
#   RG=omni-launcher-rg LOCATION=southcentralus ./deploy.sh
#
# Env overrides:
#   SITE_NAME                                      Web App name (globally unique; default: omni-launcher)
#   PG_PASSWORD, RUNTIME_TOKEN_SECRET, WS_TOKEN   secrets (default: random, URL-safe)
#   ACR_NAME                                       registry to create (default: omnilauncheracr)
#   AUTH_MODE                                      easyauth | none (default: easyauth)
#   AAD_CLIENT_ID / AAD_CLIENT_SECRET             reuse an existing AAD app (else one is created)
#   SOURCE_ACR                                     registry to import images FROM (default: omniplatformcr)
#   LAUNCHER_TAG / DEVBOX_TAG                       image repo:tags (defaults below)
#   AUTO_APPROVE=1                                 skip the what-if confirmation prompt
#
# `az bicep build` (compile/lint) needs no subscription; this script does.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Load the deployment's recorded secrets/identifiers (gitignored) so a redeploy
# reuses the live values instead of generating new ones — otherwise deploy.sh
# would reset the PG password, mint a new AAD app, and target a different site
# name, breaking the running environment. See deploy.env.sample.
if [[ -f "$HERE/deploy.env" ]]; then
  echo "Loading $HERE/deploy.env"
  # shellcheck disable=SC1091
  source "$HERE/deploy.env"
fi

RG="${RG:-omni-launcher-rg}"
LOCATION="${LOCATION:-southcentralus}"
SITE_NAME="${SITE_NAME:-omni-launcher}"
ACR_NAME="${ACR_NAME:-omnilauncheracr}"
AUTH_MODE="${AUTH_MODE:-easyauth}"
SOURCE_ACR="${SOURCE_ACR:-omniplatformcr}"
LAUNCHER_TAG="${LAUNCHER_TAG:-omni-launcher:latest}"
DEVBOX_TAG="${DEVBOX_TAG:-omni-launcher-devbox:latest}"

# hex (URL-safe) — base64's +/ would need encoding in the connection string.
PG_PASSWORD="${PG_PASSWORD:-$(openssl rand -hex 24)}"
# Password for the non-superuser omni_app role the launcher connects as (RLS-enforced).
OMNI_APP_PASSWORD="${OMNI_APP_PASSWORD:-$(openssl rand -hex 24)}"
RUNTIME_TOKEN_SECRET="${RUNTIME_TOKEN_SECRET:-$(openssl rand -hex 32)}"
# AES-256-GCM key (32 bytes, base64) for PgSecretStore. Rotating it orphans
# every existing user_secrets / team_secrets row, so pin in deploy.env.
OMNI_SECRET_KEY="${OMNI_SECRET_KEY:-$(openssl rand -base64 32)}"
WS_TOKEN="${WS_TOKEN:-$(openssl rand -hex 16)}"

# EasyAuth needs an AAD app registration (ARM can't create it). Create one for
# the known redirect URI unless the caller passed an existing app's creds.
# Without EasyAuth the browser SPA can't reach /api/ws-token and never connects.
if [[ "$AUTH_MODE" == "easyauth" && -z "${AAD_CLIENT_ID:-}" ]]; then
  echo "== creating AAD app registration for EasyAuth =="
  AAD_CLIENT_ID=$(az ad app create --display-name "${SITE_NAME}-auth" \
    --web-redirect-uris "https://${SITE_NAME}.azurewebsites.net/.auth/login/aad/callback" \
    --enable-id-token-issuance true --query appId -o tsv)
  AAD_CLIENT_SECRET=$(az ad app credential reset --id "$AAD_CLIENT_ID" --display-name easyauth --query password -o tsv 2>/dev/null)
  echo "AAD app: $AAD_CLIENT_ID"
fi

echo "Resource group : $RG ($LOCATION)"
echo "Web App        : $SITE_NAME"
echo "Registry       : $ACR_NAME (importing images from $SOURCE_ACR)"
echo "Auth mode      : $AUTH_MODE${AAD_CLIENT_ID:+ (AAD $AAD_CLIENT_ID)}"

az group create --name "$RG" --location "$LOCATION" --output none

params=(location="$LOCATION" siteName="$SITE_NAME" acrName="$ACR_NAME" authMode="$AUTH_MODE"
  postgresAdminPassword="$PG_PASSWORD" omniAppPassword="$OMNI_APP_PASSWORD"
  runtimeTokenSecret="$RUNTIME_TOKEN_SECRET" omniSecretKey="$OMNI_SECRET_KEY" wsToken="$WS_TOKEN"
  aadClientId="${AAD_CLIENT_ID:-}" aadClientSecret="${AAD_CLIENT_SECRET:-}")

echo "== what-if =="
az deployment group what-if --resource-group "$RG" --template-file "$HERE/main.bicep" \
  --parameters @"$HERE/main.parameters.json" --parameters "${params[@]}"

if [[ "${AUTO_APPROVE:-0}" != "1" ]]; then
  read -r -p "Proceed with deployment? [y/N] " ok
  [[ "$ok" == "y" || "$ok" == "Y" ]] || { echo "aborted"; exit 1; }
fi

outputs=$(az deployment group create --resource-group "$RG" --template-file "$HERE/main.bicep" \
  --parameters @"$HERE/main.parameters.json" --parameters "${params[@]}" \
  --query properties.outputs --output json)
echo "$outputs"

# Images: the current flow builds them straight into $ACR_NAME
# (scripts/build-launcher-image.sh + `npm run build:devbox{,-min}` → push), so
# importing is OFF by default — a stray import from SOURCE_ACR would OVERWRITE
# those freshly-built images with a (possibly stale or missing) copy. Set
# IMPORT_IMAGES=1 only to seed a brand-new empty registry from another ACR.
if [[ "${IMPORT_IMAGES:-0}" == "1" ]]; then
  echo "== importing images $SOURCE_ACR -> $ACR_NAME =="
  az acr import --name "$ACR_NAME" --source "${SOURCE_ACR}.azurecr.io/${LAUNCHER_TAG}" --image "$LAUNCHER_TAG" --force
  az acr import --name "$ACR_NAME" --source "${SOURCE_ACR}.azurecr.io/${DEVBOX_TAG}" --image "$DEVBOX_TAG" --force
else
  echo "== skipping image import (build into $ACR_NAME directly; IMPORT_IMAGES=1 to seed) =="
fi

echo "== restarting Web App $SITE_NAME =="
az webapp restart --resource-group "$RG" --name "$SITE_NAME"

# ---------------------------------------------------------------------------
# Build + deploy the ACI orphan-cleanup Function (TimerTrigger).
# Skip with SKIP_FUNCTION_DEPLOY=1 if you only want infra reconcile (rare —
# the bicep created the Function App as an empty shell that won't fire any
# code until this step uploads the package).
# ---------------------------------------------------------------------------
FUNC_APP_NAME=$(echo "$outputs" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("aciCleanupFunctionName",{}).get("value",""))')
if [[ -n "$FUNC_APP_NAME" && "${SKIP_FUNCTION_DEPLOY:-0}" != "1" ]]; then
  echo "== building ACI cleanup Function =="
  FN_DIR="$HERE/functions/aci-cleanup"
  (
    cd "$FN_DIR"
    if [[ ! -d node_modules ]]; then
      npm install --no-audit --no-fund >/dev/null
    fi
    npm run build >/dev/null
  )
  # Package: include host.json + dist/ + node_modules (production only).
  echo "== packaging =="
  ZIP="/tmp/aci-cleanup-$(date +%s).zip"
  (
    cd "$FN_DIR"
    rm -rf node_modules_prod
    cp -r node_modules node_modules_prod
    # Prune devDeps from the copy so the upload stays small.
    (cd node_modules_prod && npm prune --omit=dev >/dev/null 2>&1 || true)
    rm -f "$ZIP"
    # `zip -r` from inside the dir so paths in the archive are relative.
    mv node_modules node_modules_dev && mv node_modules_prod node_modules
    zip -qr "$ZIP" host.json package.json dist node_modules
    mv node_modules node_modules_prod && mv node_modules_dev node_modules
    rm -rf node_modules_prod
  )
  echo "== deploying $ZIP to $FUNC_APP_NAME =="
  az functionapp deployment source config-zip -g "$RG" -n "$FUNC_APP_NAME" --src "$ZIP" >/dev/null
  rm -f "$ZIP"
  echo "ACI cleanup Function deployed (runs every 30 min + on startup)."
else
  echo "== skipping ACI cleanup Function deploy =="
fi

echo
echo "Done. App: $(echo "$outputs" | python3 -c 'import json,sys; print(json.load(sys.stdin)["launcherUrl"]["value"])')"
echo "Note: the launcher auto-provisions the non-superuser omni_app role on boot (OMNI_DATABASE_ADMIN_URL) and refuses to start if its data role can bypass RLS. No manual SQL step."
