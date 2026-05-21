# Deploying the Omni Code Launcher (Azure)

The runbook for the cloud deployment (ACI host-runs-agent model). Two workflows:

- **A. Ship a code change** (the common case) — build an image, push, pin the
  digest, restart. No `deploy.sh`.
- **B. Provision / change infrastructure** — `deploy.sh` (first time, or when
  `main.bicep` changes, e.g. adding the VNet).

> The live deployment's identifiers + secrets are in **`infra/deploy.env`**
> (gitignored; template: `deploy.env.sample`). `deploy.sh` sources it so a
> redeploy reuses them instead of generating new ones. Fill it in before either
> workflow: `cp infra/deploy.env.sample infra/deploy.env` and populate from the
> running app (the sample documents the `az` command for each value).

## Prerequisites

- `az login` (subscription = `AZURE_SUBSCRIPTION_ID` in `deploy.env`)
- Docker, Node, and `az` CLI
- `source infra/deploy.env` (gives you `$RG`, `$SITE_NAME`, `$ACR_NAME`, …)

## The three images (all in `$ACR_NAME` = omnilauncheracr)

| Image | Built by | Contents |
|---|---|---|
| `omni-launcher:latest` | `scripts/build-launcher-image.sh` | the server (control plane); bakes `omni-code` + `omniagents` |
| `omni-launcher-devbox-min:latest` | `npm run build:devbox-min` | thin sandbox (fast `aci` profile, ~166 MB) |
| `omni-launcher-devbox:latest` | `npm run build:devbox` | full sandbox (`aci-desktop`: IDE + VNC, ~3.3 GB) |

The launcher image version is pinned in **one** place — `src/lib/omni-version.ts`
(`OMNI_CODE_VERSION`); the build script reads it, and `omni-code` pins
`omniagents` exactly, so the build is reproducible.

## A. Ship a code change

```bash
source infra/deploy.env

# 1. Build + push the launcher image (reads OMNI_CODE_VERSION from omni-version.ts).
#    Re-logs in to ACR before push (long builds outlast the token).
OMNI_PIP_INDEX="$OMNI_PIP_INDEX" \
  scripts/build-launcher-image.sh "$ACR_NAME.azurecr.io/omni-launcher:latest" --push

# 2. VERIFY the bake before relying on it (cached layers can serve stale pkgs).
docker run --rm --entrypoint sh "$ACR_NAME.azurecr.io/omni-launcher:latest" -c \
  '/opt/pipx/venvs/omni-code/bin/python -m pip show omni-code omniagents | grep -E "^Name|^Version"; echo "OMNI_CLI_PATH=$OMNI_CLI_PATH"'

# 3. Pin the new digest — App Service does NOT re-pull :latest on restart.
DIGEST=$(az acr repository show -n "$ACR_NAME" --image omni-launcher:latest --query digest -o tsv)
az webapp config set -g "$RG" -n "$SITE_NAME" \
  --linux-fx-version "DOCKER|$ACR_NAME.azurecr.io/omni-launcher@$DIGEST"

# 4. Restart + health-check (HTTP 401 = up, EasyAuth enforcing; 200/302 also OK).
az webapp restart -g "$RG" -n "$SITE_NAME"
curl -s -o /dev/null -w "%{http_code}\n" "https://$SITE_NAME.azurewebsites.net/"
```

Sandbox-image change? Rebuild + push the relevant devbox image instead, e.g.:
```bash
az acr login -n "$ACR_NAME"
docker build -f sandbox-image/Dockerfile.min -t "$ACR_NAME.azurecr.io/omni-launcher-devbox-min:latest" sandbox-image
docker push "$ACR_NAME.azurecr.io/omni-launcher-devbox-min:latest"
```
ACI pulls the devbox image fresh per sandbox, so no digest pin/restart needed.

## B. Provision / change infrastructure

`deploy.sh` runs `what-if`, then applies `main.bicep`. It **reuses** the secrets
in `deploy.env` (no clobbering) and skips image import by default (images are
built into the ACR directly — see workflow A).

```bash
source infra/deploy.env
./infra/deploy.sh            # what-if → confirm → apply; AUTO_APPROVE=1 to skip the prompt
# Then pin the launcher digest + restart (workflow A, steps 3-4) — bicep sets
# linuxFxVersion to the :latest TAG, which won't update on later restarts.
```

First-ever provision into an empty registry: build + push the three images
first (workflow A + the devbox builds), or `IMPORT_IMAGES=1 SOURCE_ACR=<other>`
to seed from another registry.

## Post-provision (manual, once)

- **Non-superuser `omni_app` Postgres role** — RLS is bypassed by superusers, so
  the app must connect as a non-superuser. See `README.md` → "Manual
  post-provision steps" and mirror `docker/postgres-init.sql`.

## App settings worth knowing (set by bicep)

| Setting | Meaning |
|---|---|
| `OMNI_CLI_PATH=/usr/local/bin/omni` | use the image-baked CLI (no runtime venv install) |
| `OMNI_AZURE_IMAGE` | fast/default sandbox image (`-devbox-min`) |
| `OMNI_AZURE_DESKTOP_IMAGE` | desktop sandbox image (`-devbox`) |
| `OMNI_AZURE_SUBNET_ID` | delegated subnet → ACI gets private IPs (desktop profile) |
| `OMNI_DATABASE_URL`, `OMNI_RUNTIME_TOKEN_SECRET`, `OMNI_WS_TOKEN` | secrets (also in `deploy.env`) |

## Gotchas (learned the hard way)

- **App Service ignores `:latest` on restart** — always pin the `@sha256:` digest.
- **Verify the baked image** — a cached Docker layer can ship a stale package;
  `pip show` it before pinning.
- **Long builds expire the ACR token** — `build-launcher-image.sh` re-logs in
  before push; for manual `docker push`, run `az acr login -n $ACR_NAME` first.
- **`/root` is ephemeral** (App Service storage off) — that's why the CLI is
  baked into the image (`OMNI_CLI_PATH`) instead of installed at boot.
- **Never run `deploy.sh` without `deploy.env`** — it would regenerate secrets,
  mint a new AAD app, and target the default site name, breaking the live env.
