# Infrastructure (Azure, Bicep)

Infrastructure-as-code for the multi-tenant cloud deployment (Path B): the
launcher server runs as the stateless control plane and provisions agent
sandboxes as Azure Container Apps directly. `main.bicep` declares everything
the server (`src/server/managers.ts`) and the `aci` sandbox-profile builder
(`src/main/aci-profile.ts`) read from the environment at runtime.

## What it provisions

| Resource | Purpose | App env var(s) produced |
|---|---|---|
| User-assigned managed identity | AcrPull + create-container-apps + Files | `AZURE_CLIENT_ID` |
| Log Analytics workspace | Container Apps + app logs | — |
| Container Registry (ACR) | launcher + agent images | `OMNI_AZURE_REGISTRY`, `OMNI_AZURE_ACR_USERNAME` |
| Storage account + file share | per-project workspace (Azure Files) | `AZURE_STORAGE_ACCOUNT_NAME` |
| Container Apps managed environment | where agent sandboxes spawn | `OMNI_AZURE_ENV` |
| PostgreSQL Flexible Server + db | pooled multi-tenant data (RLS) | `OMNI_DATABASE_URL` |
| Web App for Containers + plan | the launcher server | `OMNI_DATA_API_URL`, `OMNI_AZURE_*`, … |

Role assignments granted to the managed identity: **AcrPull** (on the ACR) and
**Contributor** (on the resource group — so the app can `PUT`
`Microsoft.App/containerApps`). No Storage Files data-plane role is granted: ACI
mounts the workspace share via the account key (`AzureFileVolume`), not SMB RBAC.

## Validate locally (no subscription)

```bash
az bicep build --file main.bicep --stdout > /dev/null   # compile + lint
```

## Deploy

```bash
RG=omni-launcher-rg LOCATION=southcentralus \
LAUNCHER_IMAGE=<acr>.azurecr.io/omni-launcher:latest \
PG_PASSWORD='…' RUNTIME_TOKEN_SECRET='…' \
./deploy.sh
```

`deploy.sh` runs `what-if` first, then `az deployment group create`. Secrets
default to random values if unset — set `RUNTIME_TOKEN_SECRET` to a **stable**
value (it must be identical across replicas; see `src/server/runtime-token.ts`).

Chicken-and-egg: the Web App references `launcherImage`. Either push the image
to a pre-existing registry first, or deploy once (the app will fail to pull),
then `az acr build`/push and restart. Same for the agent image
(`OMNI_AZURE_IMAGE` → `<acr>/omni-agent:latest`).

## Manual post-provision steps (not expressible in Bicep)

1. **Non-superuser `omni_app` Postgres role — now automated.** RLS is bypassed by
   superusers, so the app MUST connect as a non-superuser. The launcher does this
   itself on boot: `omniAppPassword` (a deploy.sh-generated secret) is baked into
   `OMNI_DATABASE_URL` (the `omni_app` DSN), while the admin DSN is surfaced as
   `OMNI_DATABASE_ADMIN_URL` and used only at startup to create `omni_app`, grant
   it DML, and run migrations as the owner (so RLS applies to `omni_app`). The
   server then **refuses to start** if its data role can bypass RLS
   (`src/server/pg-bootstrap.ts`). Because the Flexible Server is private, this
   in-container bootstrap replaces the old reach-the-DB-with-psql step.

2. **EasyAuth (App Service Authentication) — now automated.** `authMode=easyauth`
   makes the server trust `x-ms-client-principal-id` as the tenant, and the
   browser SPA can't reach `/api/ws-token` without it (gated to loopback-or-
   easyauth), so it's required for a usable deploy. The Bicep provisions the
   `authsettingsV2` resource when `aadClientId`/`aadClientSecret` are supplied,
   and `deploy.sh` creates the AAD app registration automatically (for the
   `siteName`-derived redirect URI) — so a default `./deploy.sh` brings up
   EasyAuth end to end. ARM can't create the app registration itself; that's
   why the appId/secret are params. To reuse an existing app, pass
   `AAD_CLIENT_ID`/`AAD_CLIENT_SECRET`. `authMode=none` (no `aadClientId`) is
   loopback-only — the SPA won't connect.

## How the launcher gets an ARM token

The launcher delegates ACI provisioning to the `omniagents[sandbox-aci]` extra
(baked into the server image), which authenticates via azure-identity. Its
credential chain tries three sources in priority order:

1. **Service principal** — when `AZURE_CLIENT_ID` + `AZURE_CLIENT_SECRET` +
   `AZURE_TENANT_ID` are all set (explicit opt-out of platform identity).
2. **App Service / Functions managed identity** — when `IDENTITY_ENDPOINT` +
   `IDENTITY_HEADER` are present (App Service injects these automatically once an
   identity is assigned to the site). Uses `AZURE_CLIENT_ID` to select the
   user-assigned identity.
3. **IMDS** (`169.254.169.254`) — VMs and Container Apps.

This template assigns the user-assigned managed identity to the Web App and sets
`AZURE_CLIENT_ID` to its client id, so **path (2) works out of the box on App
Service — no service-principal secret required.** If you prefer a service
principal anyway, set all three `AZURE_*` settings and path (1) takes precedence.
