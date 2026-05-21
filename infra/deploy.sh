#!/usr/bin/env bash
#
# Provision the Omni Code Launcher cloud environment from main.bicep, then
# import the prebuilt images into the new registry and start the Web App.
#
# Usage:
#   RG=omni-launcher-rg LOCATION=southcentralus ./deploy.sh
#
# Env overrides:
#   PG_PASSWORD, RUNTIME_TOKEN_SECRET, WS_TOKEN   secrets (default: random)
#   ACR_NAME                                       registry to create (default: omnilauncheracr)
#   AUTH_MODE                                      easyauth | none (default: none — bring-up)
#   SOURCE_ACR                                     registry to import images FROM (default: omniplatformcr)
#   LAUNCHER_TAG / DEVBOX_TAG                       image repo:tags (defaults below)
#   AUTO_APPROVE=1                                 skip the what-if confirmation prompt
#
# `az bicep build` (compile/lint) needs no subscription; this script does.

set -euo pipefail

RG="${RG:-omni-launcher-rg}"
LOCATION="${LOCATION:-southcentralus}"
ACR_NAME="${ACR_NAME:-omnilauncheracr}"
AUTH_MODE="${AUTH_MODE:-none}"
SOURCE_ACR="${SOURCE_ACR:-omniplatformcr}"
LAUNCHER_TAG="${LAUNCHER_TAG:-omni-launcher:latest}"
DEVBOX_TAG="${DEVBOX_TAG:-omni-launcher-devbox:latest}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PG_PASSWORD="${PG_PASSWORD:-$(openssl rand -base64 24)}"
RUNTIME_TOKEN_SECRET="${RUNTIME_TOKEN_SECRET:-$(openssl rand -hex 32)}"
WS_TOKEN="${WS_TOKEN:-$(openssl rand -hex 16)}"

echo "Resource group : $RG ($LOCATION)"
echo "Registry       : $ACR_NAME (importing images from $SOURCE_ACR)"
echo "Auth mode      : $AUTH_MODE"

az group create --name "$RG" --location "$LOCATION" --output none

params=(location="$LOCATION" acrName="$ACR_NAME" authMode="$AUTH_MODE"
  postgresAdminPassword="$PG_PASSWORD" runtimeTokenSecret="$RUNTIME_TOKEN_SECRET" wsToken="$WS_TOKEN")

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

site=$(echo "$outputs" | python3 -c 'import json,sys; print(json.load(sys.stdin)["siteName"]["value"])')

# The registry was created empty; pull the prebuilt images in from SOURCE_ACR
# (no rebuild), then start the Web App so it can pull the launcher image.
echo "== importing images $SOURCE_ACR -> $ACR_NAME =="
az acr import --name "$ACR_NAME" --source "${SOURCE_ACR}.azurecr.io/${LAUNCHER_TAG}" --image "$LAUNCHER_TAG" --force
az acr import --name "$ACR_NAME" --source "${SOURCE_ACR}.azurecr.io/${DEVBOX_TAG}" --image "$DEVBOX_TAG" --force

echo "== restarting Web App $site =="
az webapp restart --resource-group "$RG" --name "$site"

echo
echo "Done. App: $(echo "$outputs" | python3 -c 'import json,sys; print(json.load(sys.stdin)["launcherUrl"]["value"])')"
echo "Next (for multi-tenant prod): create the omni_app SQL role + enable EasyAuth (authMode=easyauth) — see README.md."
