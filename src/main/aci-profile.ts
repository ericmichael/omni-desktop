/**
 * Generate the `aci` sandbox profile for cloud deployments.
 *
 * Azure connection details (subscription, resource group, storage account key)
 * are deployment-specific and can't ship in a bundled profile, and omni-code
 * only interpolates `${workspace_dir}` in profiles — so when Azure is
 * configured the launcher writes `<config>/sandbox/aci.yml` from its own env at
 * boot. `omni serve --profile` then drives the omniagents AzureContainerSandbox
 * (`client.type: aci`), provisioning a serverless ACI container per session.
 *
 * The file is JSON, which is valid YAML — avoids a serializer dependency and
 * quotes the storage key safely.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Fast, minimal cloud sandbox: thin image, no in-sandbox services. */
export const ACI_PROFILE_NAME = 'aci';
/** Full cloud sandbox: heavy devbox image + code-server/VNC behind the proxy. */
export const ACI_DESKTOP_PROFILE_NAME = 'aci-desktop';

/**
 * Build an `aci` profile (JSON/YAML), or null if Azure isn't configured.
 *
 * ``desktop=false`` → the fast default: thin image, no exposed ports/services,
 * so the ACI group skips VNet/IP wiring. ``desktop=true`` → the full devbox
 * image with code-server + VNC on exposed ports, reachable through the
 * launcher's private-networked /proxy.
 */
export function buildAciProfile(env: NodeJS.ProcessEnv = process.env, desktop = false): string | null {
  const subscriptionId = env['OMNI_AZURE_SUBSCRIPTION_ID'];
  if (!subscriptionId) {
    return null;
  }

  const client: Record<string, unknown> = {
    type: ACI_PROFILE_NAME,
    subscription_id: subscriptionId,
    resource_group: env['OMNI_AZURE_RESOURCE_GROUP'] ?? 'omni-launcher-rg',
    location: env['OMNI_AZURE_LOCATION'] ?? 'southcentralus',
  };

  // Registry pull auth for the ACI group. Prefer a user-assigned managed
  // identity (OMNI_AZURE_IDENTITY_ID, with AcrPull) — no shared admin password.
  // Fall back to admin username/password if no identity is configured.
  const registryServer = env['OMNI_AZURE_REGISTRY'];
  const registryIdentity = env['OMNI_AZURE_IDENTITY_ID'];
  const registryUser = env['OMNI_AZURE_ACR_USERNAME'];
  const registryPassword = env['OMNI_AZURE_ACR_PASSWORD'];
  if (registryServer && registryIdentity) {
    client['registry'] = { server: registryServer, identity: registryIdentity };
  } else if (registryServer && registryUser && registryPassword) {
    client['registry'] = {
      server: registryServer,
      username: registryUser,
      password: registryPassword,
    };
  }

  // Delegated subnet → ACI groups join the VNet with *private* IPs. Both
  // profiles join (not just desktop): a no-service sandbox still needs the VNet
  // to reach the private Storage/ACR endpoints. The desktop profile additionally
  // exposes ports (private IP) fronted by the launcher's /proxy.
  const subnetId = env['OMNI_AZURE_SUBNET_ID'];
  if (subnetId) {
    client['subnet_id'] = subnetId;
  }

  // Azure Files mount = the durable workspace (the container is disposable).
  // ACI mounts via the account key (AzureFileVolume), not SMB RBAC.
  const account = env['AZURE_STORAGE_ACCOUNT_NAME'];
  const key = env['AZURE_STORAGE_ACCOUNT_KEY'];
  if (account && key) {
    client['file_share'] = {
      account_name: account,
      account_key: key,
      share_name: env['OMNI_AZURE_FILE_SHARE'] ?? 'workspaces',
      mount_path: '/workspace',
    };
  }

  // Fast profile → thin image, no services/ports. Desktop profile → the full
  // devbox image (OMNI_AZURE_DESKTOP_IMAGE; falls back to the non-"min" name)
  // with code-server + VNC on exposed ports behind the launcher's /proxy.
  const minImage = env['OMNI_AZURE_IMAGE'] ?? 'REPLACE.azurecr.io/omni-launcher-devbox-min:latest';
  const desktopImage = env['OMNI_AZURE_DESKTOP_IMAGE'] ?? minImage.replace('-devbox-min', '-devbox');

  const profile: Record<string, unknown> = {
    version: 1,
    client,
    options: {
      image: desktop ? desktopImage : minImage,
      ...(desktop ? { exposed_ports: [8080, 6080] } : {}),
    },
    manifest: { root: '/workspace' },
    ...(desktop
      ? {
          services: {
            code_server: { command: 'code-server --bind-addr 0.0.0.0:8080 --auth none /workspace', port: 8080 },
            vnc: { command: 'bash /usr/local/bin/start-vnc.sh', port: 6080 },
          },
        }
      : {}),
    terminal: { command: 'bash -i', cwd: '/workspace' },
  };

  return `${JSON.stringify(profile, null, 2)}\n`;
}

/**
 * Write both cloud sandbox profiles (`aci.yml` fast + `aci-desktop.yml` full)
 * to `<configDir>/sandbox/` when Azure is configured. Returns the fast profile's
 * path, or null when Azure isn't configured (no-op).
 */
export function writeAciProfile(configDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const fast = buildAciProfile(env, false);
  if (fast === null) {
    return null;
  }
  const dir = join(configDir, 'sandbox');
  mkdirSync(dir, { recursive: true });

  const fastPath = join(dir, `${ACI_PROFILE_NAME}.yml`);
  writeFileSync(fastPath, fast, 'utf-8');

  const desktop = buildAciProfile(env, true);
  if (desktop !== null) {
    writeFileSync(join(dir, `${ACI_DESKTOP_PROFILE_NAME}.yml`), desktop, 'utf-8');
  }
  return fastPath;
}
