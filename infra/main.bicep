// Omni Code Launcher — multi-tenant cloud infrastructure (Path B).
//
// Deploys the launcher server (Web App for Containers, the stateless control
// plane) plus its supporting services:
//   - Azure Container Registry              → launcher images
//   - Storage account + file share         → per-project workspace (Azure Files)
//   - PostgreSQL Flexible Server            → pooled multi-tenant data (RLS)
//   - Log Analytics                         → app logs
//   - User-assigned managed identity        → AcrPull + Key Vault
//
// The outputs are exactly the env vars the app already reads (see
// src/server/managers.ts).
//
// Deploy at resource-group scope:
//   az deployment group create -g <rg> -f main.bicep -p @main.parameters.json
//
// NOTE: this provisions resources only. Two post-provision steps are manual
// (see README.md): (1) create the non-superuser `omni_app` Postgres role that
// RLS depends on; (2) EasyAuth requires an AAD app registration.

targetScope = 'resourceGroup'

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

@description('Location for all resources.')
param location string = resourceGroup().location

@description('Short prefix for resource names (lowercase letters/numbers, 3-11 chars).')
@minLength(3)
@maxLength(11)
param namePrefix string = 'omni'

@description('Container Registry name to create (globally unique, 5-50 alphanumeric). Images are pushed/imported here.')
param acrName string = '${namePrefix}launcheracr'

@description('Launcher server image repo:tag, resolved against the ACR.')
param launcherImageRepoTag string = 'omni-launcher:latest'

@description('TCP port the launcher server listens on inside the container.')
param launcherPort int = 3001

@description('Auth mode for the launcher (easyauth behind App Service Authentication, else single-tenant).')
@allowed([
  'easyauth'
  'none'
])
param authMode string = 'easyauth'

@description('AAD app registration (client) ID for EasyAuth. Empty = no EasyAuth (loopback-only; the browser SPA will not connect). Create the app reg out of band — ARM cannot.')
param aadClientId string = ''

@description('Display name returned by /.well-known/omni-cloud (Electron clients show this while linking).')
param cloudDisplayName string = 'Omni Cloud'

@secure()
@description('Client secret for the EasyAuth AAD app registration.')
param aadClientSecret string = ''

@description('Web App name (globally unique, becomes <name>.azurewebsites.net). Knowable up front so the AAD redirect URI can be set before deploy.')
param siteName string = '${namePrefix}-launcher'

@description('Externally reachable base path appended after the site hostname for the MCP route.')
param mcpRoutePath string = '/mcp/projects'

@description('PostgreSQL administrator login.')
param postgresAdminLogin string = 'omniadmin'

@secure()
@description('PostgreSQL administrator password.')
param postgresAdminPassword string

@secure()
@description('Password for the non-superuser application role (omni_app) the launcher connects as. RLS-enforced; the admin role is used only for one-time bootstrap + migrations.')
param omniAppPassword string

@description('PostgreSQL Flexible Server SKU.')
param postgresSkuName string = 'Standard_B1ms'

@description('PostgreSQL storage size in GB.')
param postgresStorageGb int = 32

@secure()
@description('Shared HMAC secret for signing runtime tokens (must be stable across replicas, >=16 chars).')
param runtimeTokenSecret string

@secure()
@description('AES-256-GCM key (32 bytes, base64-encoded) for column-level encryption of user/team secrets in PgSecretStore (git tokens, Codex tokens, team-shared API keys). Stable: rotating loses access to existing rows.')
param omniSecretKey string

@description('App Service plan SKU for the launcher web app.')
param launcherPlanSku string = 'P0v3'

// ---------------------------------------------------------------------------
// Names (kept deterministic; uniqueString avoids global-name collisions)
// ---------------------------------------------------------------------------

var suffix = uniqueString(resourceGroup().id)
// Storage account names: 3-24 chars, lowercase alphanumeric only. Clamp since
// namePrefix(<=11) + 'st' + uniqueString(13) can reach 26.
var storageName = take(toLower('${namePrefix}st${suffix}'), 24)
var logName = '${namePrefix}-logs'
var pgName = toLower('${namePrefix}-pg-${suffix}')
var pgDatabaseName = 'omni'
// Separate logical database on the same flex server for omniagents session
// history (chat messages, audio metadata, archive/hold flags). Append-heavy
// workload — distinct from the read-heavy projects DB above — and benefits
// from independent autovacuum/retention without sharing a cluster.
var pgSessionsDatabaseName = 'omni_sessions'
var identityName = '${namePrefix}-launcher-mi'
var planName = '${namePrefix}-launcher-plan'
var workspaceShareName = 'workspaces'
var kvName = take('${namePrefix}-kv-${suffix}', 24)

// Built-in role definition IDs.
var roleAcrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var roleKvSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logName
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    // Audit-log retention. 90d is a dev default; a PHI deployment wants ~6y,
    // which exceeds Log Analytics' 730d interactive max — use the archive tier
    // or export to immutable storage for long-term retention there.
    retentionInDays: 90
  }
}

// ---------------------------------------------------------------------------
// Container registry (admin user enabled — the spec uses username/password
// registry creds; tighten to managed-identity pull later).
// ---------------------------------------------------------------------------

// ACR stays PUBLICLY reachable. The registry holds only container images — no
// PHI — so a credentialed public registry is acceptable; the data-bearing
// resources (PG/KV/Storage) are private. Keep Standard since no private
// endpoint is used.
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: { name: 'Standard' }
  properties: {
    // Admin user off — the launcher (App Service MI) pulls via the managed
    // identity's AcrPull, no shared password.
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

// ---------------------------------------------------------------------------
// Storage account + file share for per-project workspaces (Azure Files).
// ---------------------------------------------------------------------------

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    publicNetworkAccess: 'Disabled'
    networkAcls: { bypass: 'AzureServices', defaultAction: 'Deny' }
    // Encrypt at rest with the customer-managed key (CMK) in Key Vault.
    encryption: {
      identity: { userAssignedIdentity: identity.id }
      keySource: 'Microsoft.Keyvault'
      keyvaultproperties: {
        keyname: cmkKey.name
        keyvaulturi: take(kv.properties.vaultUri, length(kv.properties.vaultUri) - 1)
      }
      services: {
        file: { enabled: true, keyType: 'Account' }
        blob: { enabled: true, keyType: 'Account' }
      }
    }
  }
  dependsOn: [raKvCrypto]
}

// Private endpoint for the Files share — the launcher + sandboxes (both VNet-
// joined) mount/read it over the private `privatelink.file.core.windows.net`.
resource storagePe 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: '${storageName}-file-pe'
  location: location
  properties: {
    subnet: { id: peSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'file'
        properties: { privateLinkServiceId: storage.id, groupIds: ['file'] }
      }
    ]
  }
}
resource storagePeDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: storagePe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'file', properties: { privateDnsZoneId: fileDnsZone.id } }
    ]
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource workspaceShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: workspaceShareName
  properties: {
    accessTier: 'TransactionOptimized'
    shareQuota: 1024
  }
}

// Blob containers for snapshots (sandbox state tars per session) and audio
// (realtime/voice agent .pcm16 chunks). Both are write-once, read-occasionally
// opaque objects — Blob is the right primitive (vs Azure Files, which would
// pay for mountability we don't use). They live on the same storage account
// so they inherit the CMK encryption + the private endpoint below.
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

var snapshotsContainerName = 'snapshots'
var audioContainerName = 'audio'

resource snapshotsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: snapshotsContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource audioContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: audioContainerName
  properties: {
    publicAccess: 'None'
  }
}

// Private endpoint for the blob sub-resource so the VNet-integrated launcher
// reaches snapshots/audio over the privatelink.blob.core.windows.net zone.
// The Files PE above is `groupIds: ['file']` and doesn't cover blobs.
resource blobPe 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: '${storageName}-blob-pe'
  location: location
  properties: {
    subnet: { id: peSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'blob'
        properties: { privateLinkServiceId: storage.id, groupIds: ['blob'] }
      }
    ]
  }
}
resource blobPeDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: blobPe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'blob', properties: { privateDnsZoneId: blobDnsZone.id } }
    ]
  }
}

// ---------------------------------------------------------------------------
// Virtual network. The launcher's App Service joins the `appsvc` subnet via
// regional VNet integration so it can reach the private endpoints; Postgres
// gets native VNet integration in its delegated subnet. RFC1918 traffic routes
// through the VNet by default.
// ---------------------------------------------------------------------------

var vnetName = '${namePrefix}-vnet'
var integrationSubnetName = 'appsvc'
var pgSubnetName = 'pg'
var peSubnetName = 'privatelink'

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.40.0.0/16'] }
    subnets: [
      {
        name: integrationSubnetName
        properties: {
          addressPrefix: '10.40.2.0/24'
          delegations: [
            {
              name: 'appsvc-delegation'
              properties: { serviceName: 'Microsoft.Web/serverFarms' }
            }
          ]
        }
      }
      {
        // Delegated to Postgres Flexible Server for native VNet integration.
        name: pgSubnetName
        properties: {
          addressPrefix: '10.40.3.0/24'
          delegations: [
            {
              name: 'pg-delegation'
              properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' }
            }
          ]
        }
      }
      {
        // Holds private endpoints (Key Vault, …).
        name: peSubnetName
        properties: {
          addressPrefix: '10.40.4.0/24'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

// Private DNS zones so the VNet (App Service + sandboxes) resolves these
// services to their private IPs. Linked to the VNet below; the PG server and
// the KV private endpoint register their A records into these.
resource pgDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: '${namePrefix}.private.postgres.database.azure.com'
  location: 'global'
}
resource pgDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: pgDnsZone
  name: 'vnet-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}
resource kvDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.vaultcore.azure.net'
  location: 'global'
}
resource kvDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: kvDnsZone
  name: 'vnet-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}
resource fileDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.file.core.windows.net'
  location: 'global'
}
resource fileDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: fileDnsZone
  name: 'vnet-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}
resource blobDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.blob.core.windows.net'
  location: 'global'
}
resource blobDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: blobDnsZone
  name: 'vnet-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}
// (No ACR private DNS zone — ACR stays public; see the ACR resource note.)

var pgSubnetId = '${vnet.id}/subnets/${pgSubnetName}'
var peSubnetId = '${vnet.id}/subnets/${peSubnetName}'

// String-built id (rather than an `existing` ref) so it carries an implicit
// dependency on the VNet resource above.
var integrationSubnetId = '${vnet.id}/subnets/${integrationSubnetName}'

// ---------------------------------------------------------------------------
// PostgreSQL Flexible Server (pooled multi-tenant data; RLS-backed).
// ---------------------------------------------------------------------------

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: pgName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  sku: {
    name: postgresSkuName
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: {
      storageSizeGB: postgresStorageGb
    }
    highAvailability: {
      mode: 'Disabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    // Native VNet integration → the server has a private IP in the `pg` subnet
    // and NO public endpoint. Resolved via the linked private DNS zone.
    network: {
      delegatedSubnetResourceId: pgSubnetId
      privateDnsZoneArmResourceId: pgDnsZone.id
    }
    // Encrypt at rest with the customer-managed key (CMK).
    dataEncryption: {
      type: 'AzureKeyVault'
      primaryKeyURI: cmkKey.properties.keyUriWithVersion
      primaryUserAssignedIdentityId: identity.id
    }
  }
  dependsOn: [pgDnsLink, raKvCrypto]
}

resource pgDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: pgDatabaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// omniagents session history (chat messages, audio metadata) — read by the
// omni_app role using OMNIAGENTS_HISTORY_URL. The launcher's pg-bootstrap
// grants omni_app CREATE on its public schema so PgSessionStorage can
// CREATE TABLE IF NOT EXISTS on first spawn.
resource pgSessionsDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: pgSessionsDatabaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// ---------------------------------------------------------------------------
// Role assignments for the managed identity
// ---------------------------------------------------------------------------

// Pull images from ACR.
resource raAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, identity.id, roleAcrPull)
  scope: acr
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleAcrPull)
  }
}

// ---------------------------------------------------------------------------
// Launcher server — Web App for Containers
// ---------------------------------------------------------------------------

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  sku: {
    name: launcherPlanSku
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
}

var siteHostName = '${siteName}.azurewebsites.net'
var dataApiUrl = 'https://${siteHostName}${mcpRoutePath}'
// URL-encode the password — a generated password can contain `/`, `+`, `@`,
// etc. which otherwise corrupt the connection-string URL and crash pg on boot.
var pgConnString = 'postgresql://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/${pgDatabaseName}?sslmode=require'
// The launcher connects as the non-superuser `omni_app` role (RLS-enforced).
// The admin DSN above is surfaced separately and used only at boot to create
// omni_app + run migrations. See src/server/pg-bootstrap.ts.
var pgAppConnString = 'postgresql://omni_app:${uriComponent(omniAppPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/${pgDatabaseName}?sslmode=require'
// omniagents session history connects as omni_app against the sibling
// omni_sessions DB. Bootstrap (GRANT CREATE on public schema) is run at
// launcher startup; the omniagents PgSessionStorage then installs its own
// tables idempotently. See ensureSessionsDb in src/server/pg-bootstrap.ts.
var pgSessionsConnString = 'postgresql://omni_app:${uriComponent(omniAppPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/${pgSessionsDatabaseName}?sslmode=require'

// ---------------------------------------------------------------------------
// Key Vault — runtime secrets live here, not as plaintext app settings. The
// Web App reads them via Key Vault references resolved with its managed
// identity (keyVaultReferenceIdentity below). RBAC auth mode (no access
// policies). Public access stays on here; the network tranche adds a private
// endpoint + turns it off.
// ---------------------------------------------------------------------------

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: tenant().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Disabled'
    networkAcls: { bypass: 'AzureServices', defaultAction: 'Deny' }
  }
}

// Private endpoint → the Web App (VNet-integrated) resolves the vault to a
// private IP via the linked privatelink.vaultcore.azure.net zone.
resource kvPe 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: '${kvName}-pe'
  location: location
  properties: {
    subnet: { id: peSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'kv'
        properties: { privateLinkServiceId: kv.id, groupIds: ['vault'] }
      }
    ]
  }
}
resource kvPeDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: kvPe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'vault', properties: { privateDnsZoneId: kvDnsZone.id } }
    ]
  }
}

// App connection (omni_app, RLS-enforced) — what the launcher uses at runtime.
resource kvSecretDbUrl 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'omni-database-url'
  properties: { value: pgAppConnString }
}
// Admin connection — used only at boot to bootstrap omni_app + run migrations.
resource kvSecretDbAdminUrl 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'omni-database-admin-url'
  properties: { value: pgConnString }
}
// omniagents history DB connection (omni_app, omni_sessions DB).
resource kvSecretSessionsDbUrl 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'omniagents-history-url'
  properties: { value: pgSessionsConnString }
}
// Admin DSN for the sessions DB — same admin role but targeted at the
// omni_sessions database, used only at boot for ensureSessionsDb.
resource kvSecretSessionsDbAdminUrl 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'omniagents-history-admin-url'
  properties: {
    value: 'postgresql://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/${pgSessionsDatabaseName}?sslmode=require'
  }
}
resource kvSecretRuntimeToken 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'runtime-token-secret'
  properties: { value: runtimeTokenSecret }
}
// AES-256-GCM key for column-level encryption in PgSecretStore. Required when
// the launcher runs in cloud (OMNI_DATABASE_URL set) — boot fails without it.
resource kvSecretOmniSecretKey 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'omni-secret-key'
  properties: { value: omniSecretKey }
}
resource kvSecretAadSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'aad-client-secret'
  properties: { value: aadClientSecret }
}
resource kvSecretStorageKey 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'storage-account-key'
  properties: { value: storage.listKeys().keys[0].value }
}

// The Web App's managed identity may read secrets.
resource raKvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, identity.id, roleKvSecretsUser)
  scope: kv
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleKvSecretsUser)
  }
}

// --- Customer-managed key (CMK) for encryption at rest -------------------- #
// Storage + Postgres encrypt at rest with this key instead of a Microsoft-
// managed one, so key rotation/revocation is under our control. The managed
// identity is granted crypto access; Storage/PG reach the (private) vault via
// its AzureServices firewall bypass.
resource cmkKey 'Microsoft.KeyVault/vaults/keys@2023-07-01' = {
  parent: kv
  name: 'cmk-encryption'
  properties: {
    kty: 'RSA'
    keySize: 3072
    keyOps: ['wrapKey', 'unwrapKey']
  }
}

// Key Vault Crypto Service Encryption User — lets the identity wrap/unwrap with
// the CMK on behalf of Storage/PG.
var roleKvCryptoEncUser = 'e147488a-f6f5-4113-8e2d-b22465e65bf6'
resource raKvCrypto 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, identity.id, roleKvCryptoEncUser)
  scope: kv
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleKvCryptoEncUser)
  }
}

// Helper: build a Key Vault reference app-setting value for a secret name.
func kvRef(vaultUri string, secretName string) string =>
  '@Microsoft.KeyVault(SecretUri=${vaultUri}secrets/${secretName})'

resource site 'Microsoft.Web/sites@2023-12-01' = {
  name: siteName
  location: location
  kind: 'app,linux,container'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    keyVaultReferenceIdentity: identity.id
    // Regional VNet integration — outbound to private (RFC1918) IPs routes
    // through the `appsvc` subnet so the launcher can reach the private
    // endpoints (Postgres, Key Vault, Storage).
    virtualNetworkSubnetId: integrationSubnetId
    // Pull the launcher's own container image from the private ACR through the
    // VNet (required once ACR public access is off).
    vnetImagePullEnabled: true
    siteConfig: {
      linuxFxVersion: 'DOCKER|${acr.properties.loginServer}/${launcherImageRepoTag}'
      alwaysOn: true
      // Liveness probe (src/server/index.ts → GET /healthz, excluded from
      // EasyAuth below). App Service marks an instance unhealthy on non-2xx.
      healthCheckPath: '/healthz'
      // The renderer's transport dials /ws — App Service disables WebSockets by
      // default, silently closing the upgrade and triggering a reconnect loop.
      webSocketsEnabled: true
      ftpsState: 'Disabled'
      acrUseManagedIdentityCreds: true
      acrUserManagedIdentityID: identity.properties.clientId
      appSettings: [
        { name: 'WEBSITES_PORT', value: string(launcherPort) }
        { name: 'PORT', value: string(launcherPort) }
        { name: 'DOCKER_REGISTRY_SERVER_URL', value: 'https://${acr.properties.loginServer}' }
        { name: 'OMNI_AUTH_MODE', value: authMode }
        { name: 'OMNI_DATABASE_URL', value: kvRef(kv.properties.vaultUri, 'omni-database-url') }
        { name: 'OMNI_DATABASE_ADMIN_URL', value: kvRef(kv.properties.vaultUri, 'omni-database-admin-url') }
        // omniagents session-history backend (chat messages, audio metadata).
        // managers.ts reads OMNIAGENTS_HISTORY_URL and propagates it + the
        // backend selector + tenant id to each spawned `omni serve`.
        { name: 'OMNIAGENTS_HISTORY_URL', value: kvRef(kv.properties.vaultUri, 'omniagents-history-url') }
        { name: 'OMNIAGENTS_HISTORY_ADMIN_URL', value: kvRef(kv.properties.vaultUri, 'omniagents-history-admin-url') }
        { name: 'OMNI_RUNTIME_TOKEN_SECRET', value: kvRef(kv.properties.vaultUri, 'runtime-token-secret') }
        // Required when OMNI_DATABASE_URL is set — PgSecretStore (git/codex/team
        // secrets, AES-256-GCM) refuses to construct without it.
        { name: 'OMNI_SECRET_KEY', value: kvRef(kv.properties.vaultUri, 'omni-secret-key') }
        { name: 'OMNI_DATA_API_URL', value: dataApiUrl }
        { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
        { name: 'AZURE_STORAGE_ACCOUNT_NAME', value: storage.name }
        // Azure Files artifact share (managers.ts reads OMNI_AZURE_FILE_SHARE)
        // is mounted via the account key, so the launcher needs it + the name.
        { name: 'AZURE_STORAGE_ACCOUNT_KEY', value: kvRef(kv.properties.vaultUri, 'storage-account-key') }
        { name: 'OMNI_AZURE_FILE_SHARE', value: workspaceShareName }
        // Blob containers for sandbox snapshots + realtime audio. Launcher's
        // agent-process.ts uploads snapshot tars here so they survive App
        // Service container recycles; omniagents' AzureBlobAudioStorage writes
        // .pcm16 chunks for voice sessions.
        { name: 'OMNI_AZURE_SNAPSHOT_CONTAINER', value: snapshotsContainerName }
        { name: 'OMNI_AZURE_AUDIO_CONTAINER', value: audioContainerName }
        // Referenced by the EasyAuth (authsettingsV2) AAD provider below.
        { name: 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET', value: kvRef(kv.properties.vaultUri, 'aad-client-secret') }
        // Cloud-link discovery — Electron clients GET /.well-known/omni-cloud
        // to self-configure for the AAD device-code flow before sign-in.
        // See infra/DEPLOY.md → "Cloud-link from the Electron desktop app".
        { name: 'OMNI_AAD_TENANT_ID', value: tenant().tenantId }
        { name: 'OMNI_AAD_CLIENT_ID', value: aadClientId }
        { name: 'OMNI_CLOUD_NAME', value: cloudDisplayName }
      ]
    }
  }
  // KV references resolve via the managed identity — ensure the secrets exist
  // and the read role is granted before the app starts.
  dependsOn: [
    kvSecretDbUrl
    kvSecretDbAdminUrl
    kvSecretSessionsDbUrl
    kvSecretSessionsDbAdminUrl
    kvSecretRuntimeToken
    kvSecretOmniSecretKey
    kvSecretAadSecret
    kvSecretStorageKey
    raKvSecretsUser
  ]
}

// App Service Authentication (EasyAuth). Created only when an AAD app
// registration is supplied (ARM/Bicep cannot create the app registration — do
// it out of band: `az ad app create … --web-redirect-uris
// https://<site>/.auth/login/aad/callback` — and pass aadClientId/Secret).
// Without it the SPA can't reach /api/ws-token (gated to loopback-or-easyauth)
// so the app never connects. Requires `authMode=easyauth` (set above) for the
// server to trust the injected x-ms-client-principal-id.
resource siteAuth 'Microsoft.Web/sites/config@2023-12-01' = if (!empty(aadClientId)) {
  parent: site
  name: 'authsettingsV2'
  properties: {
    platform: { enabled: true }
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
      // Excluded paths bypass EasyAuth entirely; the launcher does its own
      // auth for these:
      //   - /.well-known/omni-cloud — public discovery (no auth required)
      //   - /healthz — unauthenticated liveness probe (App Service health
      //     check); no secrets, returns {status:'ok'}.
      //   - /ws — the renderer's browser WebSocket API can't send Bearer
      //     headers on the upgrade. The launcher auths /ws via a signed
      //     token minted by /api/ws-token (which IS still behind EasyAuth,
      //     so the principal identity is baked into the token there).
      //   - /ws/chat — chat-v1's public binding (docs/chat-v1-plan.md);
      //     same signed-token auth as /ws (plus raw bridge keys), and its
      //     clients (mobile apps, network bridges) have no EasyAuth cookie
      //     to present on the upgrade.
      //   - /proxy — reverse-proxy routes to in-sandbox UIs (code-server,
      //     VNC, etc.). EasyAuth-gating breaks iframe loads from cross-
      //     origin Electron clients. The proxy-name suffix is unguessable
      //     (~96 bits of entropy) and the sandbox itself runs on a private
      //     VNet; /proxy/_register additionally enforces its own CIDR
      //     allowlist (see src/server/proxy-rewriter.ts isTrusted).
      excludedPaths: ['/.well-known/omni-cloud', '/healthz', '/ws', '/ws/chat', '/proxy/*']
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: aadClientId
          clientSecretSettingName: 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'
          openIdIssuer: 'https://login.microsoftonline.com/${tenant().tenantId}/v2.0'
        }
        validation: {
          allowedAudiences: [aadClientId, 'api://${aadClientId}']
        }
      }
    }
    login: { tokenStore: { enabled: true } }
  }
}

// ---------------------------------------------------------------------------
// Audit logging — ship resource logs + metrics to Log Analytics so access to
// each component is recorded (HIPAA audit-controls posture). Retention is the
// workspace's (see `logs` above; bump to archive tier for long-term).
// ---------------------------------------------------------------------------

resource diagSite 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: site
  name: 'to-logs'
  properties: {
    workspaceId: logs.id
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

resource diagPg 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: postgres
  name: 'to-logs'
  properties: {
    workspaceId: logs.id
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

resource diagAcr 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: acr
  name: 'to-logs'
  properties: {
    workspaceId: logs.id
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

resource diagKv 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: kv
  name: 'to-logs'
  properties: {
    workspaceId: logs.id
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

// Azure Files data-plane access (who read/wrote/deleted workspace files).
resource diagFiles 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: fileService
  name: 'to-logs'
  properties: {
    workspaceId: logs.id
    logs: [
      { category: 'StorageRead', enabled: true }
      { category: 'StorageWrite', enabled: true }
      { category: 'StorageDelete', enabled: true }
    ]
    metrics: [{ category: 'Transaction', enabled: true }]
  }
}

// ---------------------------------------------------------------------------
// Outputs — the values you wire into the app / verify after deploy.
// ---------------------------------------------------------------------------

output launcherUrl string = 'https://${siteHostName}'
output siteName string = siteName
output dataApiUrl string = dataApiUrl
output acrLoginServer string = acr.properties.loginServer
output acrName string = acr.name
output storageAccountName string = storage.name
output workspaceShare string = workspaceShareName
output postgresFqdn string = postgres.properties.fullyQualifiedDomainName
output postgresDatabase string = pgDatabaseName
output postgresSessionsDatabase string = pgSessionsDatabaseName
output managedIdentityClientId string = identity.properties.clientId
output managedIdentityPrincipalId string = identity.properties.principalId
output vnetName string = vnet.name
