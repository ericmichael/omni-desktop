// Omni Code Launcher — multi-tenant cloud infrastructure (Path B).
//
// Deploys the launcher server (Web App for Containers, the stateless control
// plane) plus everything the in-app Azure compute client provisions against:
//   - Container Apps managed environment   → agent sandboxes spawn here
//   - Azure Container Registry              → agent + launcher images
//   - Storage account + file share         → per-project workspace (Azure Files)
//   - PostgreSQL Flexible Server            → pooled multi-tenant data (RLS)
//   - Log Analytics                         → Container Apps + app logs
//   - User-assigned managed identity        → AcrPull + create-container-apps + Files
//
// The outputs are exactly the env vars the app already reads (see
// src/main/azure-compute/azure-compute-client.ts and src/server/managers.ts).
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

@description('Fast agent sandbox image repo:tag (thin "min" image, fast cold pull) — the default `aci` profile.')
param agentImageRepoTag string = 'omni-launcher-devbox-min:latest'

@description('Desktop agent sandbox image repo:tag (full devbox: IDE + VNC + toolchains) — the `aci-desktop` profile.')
param desktopAgentImageRepoTag string = 'omni-launcher-devbox:latest'

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

@description('PostgreSQL Flexible Server SKU.')
param postgresSkuName string = 'Standard_B1ms'

@description('PostgreSQL storage size in GB.')
param postgresStorageGb int = 32

@secure()
@description('Shared HMAC secret for signing runtime tokens (must be stable across replicas, >=16 chars).')
param runtimeTokenSecret string

@secure()
@description('Static WebSocket auth token for the launcher (OMNI_WS_TOKEN). Leave empty to set later.')
param wsToken string = ''

@description('App Service plan SKU for the launcher web app.')
param launcherPlanSku string = 'P0v3'

@description('vCPU for each agent sandbox container app (decimal cores).')
param agentCpu string = '2.0'

@description('Memory for each agent sandbox container app.')
param agentMemory string = '4Gi'

// ---------------------------------------------------------------------------
// Names (kept deterministic; uniqueString avoids global-name collisions)
// ---------------------------------------------------------------------------

var suffix = uniqueString(resourceGroup().id)
// Storage account names: 3-24 chars, lowercase alphanumeric only. Clamp since
// namePrefix(<=11) + 'st' + uniqueString(13) can reach 26.
var storageName = take(toLower('${namePrefix}st${suffix}'), 24)
var logName = '${namePrefix}-logs'
var envName = '${namePrefix}-agent-env'
var pgName = toLower('${namePrefix}-pg-${suffix}')
var pgDatabaseName = 'omni'
var identityName = '${namePrefix}-launcher-mi'
var planName = '${namePrefix}-launcher-plan'
var workspaceShareName = 'workspaces'

// Built-in role definition IDs.
var roleAcrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var roleContributor = 'b24988ac-6180-42a0-ab88-20f7382dd24c'

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
    retentionInDays: 30
  }
}

// ---------------------------------------------------------------------------
// Container registry (admin user enabled — the spec uses username/password
// registry creds; tighten to managed-identity pull later).
// ---------------------------------------------------------------------------

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: { name: 'Standard' }
  properties: {
    adminUserEnabled: true
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
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
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

// ---------------------------------------------------------------------------
// Virtual network — keeps ACI sandboxes private. The agent sandbox groups join
// the delegated `aci` subnet and get *private* IPs (no public surface); their
// service ports (code-server, VNC) are reachable only inside the VNet. The
// launcher's App Service joins the `appsvc` subnet via regional VNet
// integration, so it can reach those private IPs and front them through its own
// EasyAuth-protected /proxy. RFC1918 traffic routes through the VNet by default,
// so Postgres (public FQDN) keeps using the normal outbound path.
// ---------------------------------------------------------------------------

var vnetName = '${namePrefix}-vnet'
var aciSubnetName = 'aci'
var integrationSubnetName = 'appsvc'

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.40.0.0/16'] }
    subnets: [
      {
        name: aciSubnetName
        properties: {
          addressPrefix: '10.40.1.0/24'
          delegations: [
            {
              name: 'aci-delegation'
              properties: { serviceName: 'Microsoft.ContainerInstance/containerGroups' }
            }
          ]
        }
      }
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
    ]
  }
}

// String-built ids (rather than `existing` refs) so they carry an implicit
// dependency on the VNet resource above.
var aciSubnetId = '${vnet.id}/subnets/${aciSubnetName}'
var integrationSubnetId = '${vnet.id}/subnets/${integrationSubnetName}'

// ---------------------------------------------------------------------------
// Container Apps managed environment (agent sandboxes spawn into this).
// ---------------------------------------------------------------------------

resource managedEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: envName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL Flexible Server (pooled multi-tenant data; RLS-backed).
// ---------------------------------------------------------------------------

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: pgName
  location: location
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
  }
}

resource pgDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: pgDatabaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Allow Azure services (the launcher Web App) to reach the server. Tighten to
// VNet integration for production.
resource pgAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
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

// Create/manage container apps in this resource group (the in-app compute
// client PUTs Microsoft.App/containerApps). Contributor is broad — replace
// with a custom role limited to Microsoft.App/* for least privilege.
resource raContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, identity.id, roleContributor)
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleContributor)
  }
}

// NOTE: no Storage File SMB role for the identity — ACI mounts the workspace
// share via the storage account KEY (AzureFileVolume), not SMB RBAC, so the
// launcher's managed identity needs no Files data-plane role.

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
    // Regional VNet integration — outbound to private (RFC1918) ACI IPs routes
    // through the `appsvc` subnet so the launcher can reach the sandboxes.
    virtualNetworkSubnetId: integrationSubnetId
    siteConfig: {
      linuxFxVersion: 'DOCKER|${acr.properties.loginServer}/${launcherImageRepoTag}'
      alwaysOn: true
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
        { name: 'OMNI_DATABASE_URL', value: pgConnString }
        { name: 'OMNI_RUNTIME_TOKEN_SECRET', value: runtimeTokenSecret }
        { name: 'OMNI_WS_TOKEN', value: wsToken }
        { name: 'OMNI_DATA_API_URL', value: dataApiUrl }
        { name: 'OMNI_AZURE_SUBSCRIPTION_ID', value: subscription().subscriptionId }
        { name: 'OMNI_AZURE_RESOURCE_GROUP', value: resourceGroup().name }
        { name: 'OMNI_AZURE_ENV', value: managedEnv.name }
        { name: 'OMNI_AZURE_LOCATION', value: location }
        { name: 'OMNI_AZURE_REGISTRY', value: acr.properties.loginServer }
        { name: 'OMNI_AZURE_IMAGE', value: '${acr.properties.loginServer}/${agentImageRepoTag}' }
        // Full devbox image for the `aci-desktop` profile (IDE + VNC).
        { name: 'OMNI_AZURE_DESKTOP_IMAGE', value: '${acr.properties.loginServer}/${desktopAgentImageRepoTag}' }
        // Delegated subnet the ACI sandbox groups join → private IPs only.
        // Surfaced into the aci profile's `client.subnet_id`.
        { name: 'OMNI_AZURE_SUBNET_ID', value: aciSubnetId }
        { name: 'OMNI_AZURE_ACR_USERNAME', value: acr.name }
        // ACI pulls the devbox image from this (private) ACR using these admin
        // creds, surfaced into the aci sandbox profile's `registry` block.
        { name: 'OMNI_AZURE_ACR_PASSWORD', value: acr.listCredentials().passwords[0].value }
        { name: 'OMNI_AZURE_CPU', value: agentCpu }
        { name: 'OMNI_AZURE_MEMORY', value: agentMemory }
        { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
        { name: 'AZURE_STORAGE_ACCOUNT_NAME', value: storage.name }
        // The ACI sandbox mounts the workspace file share via the account key
        // (AzureFileVolume), so the launcher needs it + the share name.
        { name: 'AZURE_STORAGE_ACCOUNT_KEY', value: storage.listKeys().keys[0].value }
        { name: 'OMNI_AZURE_FILE_SHARE', value: workspaceShareName }
        // Referenced by the EasyAuth (authsettingsV2) AAD provider below.
        { name: 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET', value: aadClientSecret }
      ]
    }
  }
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
// Outputs — the values you wire into the app / verify after deploy.
// ---------------------------------------------------------------------------

output launcherUrl string = 'https://${siteHostName}'
output siteName string = siteName
output dataApiUrl string = dataApiUrl
output acrLoginServer string = acr.properties.loginServer
output acrName string = acr.name
output containerAppsEnv string = managedEnv.name
output storageAccountName string = storage.name
output workspaceShare string = workspaceShareName
output postgresFqdn string = postgres.properties.fullyQualifiedDomainName
output postgresDatabase string = pgDatabaseName
output managedIdentityClientId string = identity.properties.clientId
output managedIdentityPrincipalId string = identity.properties.principalId
output agentImage string = '${acr.properties.loginServer}/${agentImageRepoTag}'
output vnetName string = vnet.name
output aciSubnetId string = aciSubnetId
