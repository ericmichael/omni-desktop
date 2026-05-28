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

> **ACR is private** (public access off), so a push from outside the VNet is
> blocked. For a dev push, briefly toggle public access around the push:
> ```bash
> az acr update -n "$ACR_NAME" --public-network-enabled true
> # … build + push …
> az acr update -n "$ACR_NAME" --public-network-enabled false
> ```
> (A production pipeline would build from inside the VNet / an ACR agent pool
> instead of toggling.)

```bash
source infra/deploy.env
az acr update -n "$ACR_NAME" --public-network-enabled true   # dev: open for the push

# 1. Build + push the launcher image (reads OMNI_CODE_VERSION from omni-version.ts).
#    Re-logs in to ACR before push (long builds outlast the token).
OMNI_PIP_INDEX="$OMNI_PIP_INDEX" \
  scripts/build-launcher-image.sh "$ACR_NAME.azurecr.io/omni-launcher:latest" --push
az acr update -n "$ACR_NAME" --public-network-enabled false  # close it again

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

## Post-provision

- **Non-superuser `omni_app` Postgres role — automated.** The launcher
  provisions `omni_app` on boot from `OMNI_DATABASE_ADMIN_URL` and connects as it
  via `OMNI_DATABASE_URL`, refusing to start if that role can bypass RLS. No
  manual SQL step. See `README.md` → "Manual post-provision steps".

## App settings worth knowing (set by bicep)

| Setting | Meaning |
|---|---|
| `OMNI_CLI_PATH=/usr/local/bin/omni` | use the image-baked CLI (no runtime venv install) |
| `OMNI_AZURE_IMAGE` | fast/default sandbox image (`-devbox-min`) |
| `OMNI_AZURE_DESKTOP_IMAGE` | desktop sandbox image (`-devbox`) |
| `OMNI_AZURE_SUBNET_ID` | delegated subnet → ACI gets private IPs (desktop profile) |
| `OMNI_DATABASE_URL`, `OMNI_RUNTIME_TOKEN_SECRET`, `OMNI_WS_TOKEN` | secrets (also in `deploy.env`) |
| `OMNIAGENTS_HISTORY_URL` | omniagents session DB (Postgres, `omni_sessions`) — chat history durability |
| `OMNI_AZURE_SNAPSHOT_CONTAINER` / `OMNI_AZURE_AUDIO_CONTAINER` | blob containers for sandbox snapshot tars + realtime audio chunks |
| `OMNI_AAD_TENANT_ID` / `OMNI_AAD_CLIENT_ID` / `OMNI_CLOUD_NAME` | published by `/.well-known/omni-cloud` so Electron clients can self-configure for cloud-link sign-in |

## Cloud-link from the Electron desktop app

The desktop launcher can link to this deployment so chat sessions, projects,
and tickets sync to the cloud Postgres and back to the web UI. The user
opens **Settings → General → Connect to Cloud**, pastes the launcher URL,
and approves the device-code flow against your AAD tenant.

### AAD app registration must allow public client / device code

The same AAD app reg that EasyAuth uses for the SPA browser flow also
serves the desktop's device-code flow. **One-time portal toggle**:

```bash
az ad app update --id "$OMNI_AAD_CLIENT_ID" --is-fallback-public-client true
```

Equivalent UI path: *App registrations → <app> → Authentication → Advanced
settings → "Allow public client flows" = Yes*. Without this AAD rejects the
device-code request with `unauthorized_client`.

### `/.well-known/omni-cloud` must be reachable

The Electron client GETs `https://<launcher>/.well-known/omni-cloud` (public,
no auth) to discover the tenant + client id. The bicep sets the three env
vars (`OMNI_AAD_TENANT_ID`, `OMNI_AAD_CLIENT_ID`, `OMNI_CLOUD_NAME`) so this
endpoint just works. If it returns 503 *Cloud sign-in not configured*, those
three settings need to be present on the App Service.

### EasyAuth + Bearer tokens

No bicep change needed. The existing `authsettingsV2` config already accepts
incoming Bearer tokens whose `aud` matches `aadClientId` (or `api://<id>`).
The Electron client requests the token with scope `<clientId>/.default`,
which yields the right audience. `unauthenticatedClientAction:
RedirectToLoginPage` only triggers when no credential is presented at all —
a valid Bearer is honoured.

## Network posture (all internal resources private)

Everything except the launcher's public front door is VNet-only:

| Resource | Access |
|---|---|
| App Service (launcher) | public + EasyAuth (the only ingress) |
| Postgres | private (VNet-integrated, public off) |
| Key Vault | private endpoint, public off |
| Storage / Azure Files | private endpoint (`file`), public off |
| ACR | public, **admin user off** — launcher + sandboxes pull via managed-identity AcrPull (ACI can't pull from a private-endpoint-only ACR) |
| Sandboxes (ACI) | VNet-joined (private IPs); `omni-aci-nsg` denies sandbox→DB / →launcher / →peer |

Implications: **all** sandbox launches now pay the VNet NIC-provisioning time
(the fast profile no longer skips it); private DNS zones (`postgres`,
`vaultcore`, `file`) are VNet-linked so names resolve to the private IPs.
**Encryption at rest is customer-managed (CMK)** for Storage + Postgres — an RSA
key in Key Vault (`cmk-encryption`); the managed identity holds the crypto role.
No ACR admin password exists; image pushes use `az acr login` (AAD).

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
