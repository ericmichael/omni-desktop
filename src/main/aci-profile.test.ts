import { describe, expect, it } from 'vitest';

import { buildAciProfile } from '@/main/aci-profile';

describe('buildAciProfile', () => {
  it('returns null when Azure is not configured', () => {
    expect(buildAciProfile({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('builds an aci-type profile with the workspace Files mount', () => {
    const yaml = buildAciProfile({
      OMNI_AZURE_SUBSCRIPTION_ID: 'sub-1',
      OMNI_AZURE_RESOURCE_GROUP: 'rg-1',
      OMNI_AZURE_LOCATION: 'eastus',
      OMNI_AZURE_IMAGE: 'acr.azurecr.io/devbox:latest',
      AZURE_STORAGE_ACCOUNT_NAME: 'stacct',
      AZURE_STORAGE_ACCOUNT_KEY: 'the-key==',
      OMNI_AZURE_FILE_SHARE: 'workspaces',
      OMNI_AZURE_REGISTRY: 'acr.azurecr.io',
      OMNI_AZURE_ACR_USERNAME: 'acr',
      OMNI_AZURE_ACR_PASSWORD: 'acr-pw',
    } as NodeJS.ProcessEnv)!;
    // JSON is valid YAML — parse it back to assert structure.
    const p = JSON.parse(yaml);
    expect(p.client.type).toBe('aci');
    expect(p.client.subscription_id).toBe('sub-1');
    expect(p.client.resource_group).toBe('rg-1');
    expect(p.client.location).toBe('eastus');
    expect(p.client.file_share).toEqual({
      account_name: 'stacct',
      account_key: 'the-key==',
      share_name: 'workspaces',
      mount_path: '/workspace',
    });
    expect(p.client.registry).toEqual({
      server: 'acr.azurecr.io',
      username: 'acr',
      password: 'acr-pw',
    });
    expect(p.options.image).toBe('acr.azurecr.io/devbox:latest');
    expect(p.manifest.root).toBe('/workspace');
  });

  it('omits the file share when storage credentials are absent', () => {
    const p = JSON.parse(
      buildAciProfile({ OMNI_AZURE_SUBSCRIPTION_ID: 'sub-1' } as NodeJS.ProcessEnv)!
    );
    expect(p.client.file_share).toBeUndefined();
    expect(p.client.resource_group).toBe('omni-launcher-rg'); // default
  });

  it('is minimal by default: no services, no exposed ports, thin default image', () => {
    const p = JSON.parse(
      buildAciProfile({ OMNI_AZURE_SUBSCRIPTION_ID: 'sub-1' } as NodeJS.ProcessEnv)!
    );
    expect(p.services).toBeUndefined();
    expect(p.options.exposed_ports).toBeUndefined();
    expect(p.options.image).toContain('devbox-min');
  });

  it('includes desktop services + ports when OMNI_SANDBOX_DESKTOP=1', () => {
    const p = JSON.parse(
      buildAciProfile({
        OMNI_AZURE_SUBSCRIPTION_ID: 'sub-1',
        OMNI_SANDBOX_DESKTOP: '1',
      } as NodeJS.ProcessEnv)!
    );
    expect(p.options.exposed_ports).toEqual([8080, 6080]);
    expect(p.services.code_server.port).toBe(8080);
    expect(p.services.vnc.port).toBe(6080);
  });

  it('subnet_id flows into the client when set', () => {
    const p = JSON.parse(
      buildAciProfile({
        OMNI_AZURE_SUBSCRIPTION_ID: 'sub-1',
        OMNI_AZURE_SUBNET_ID: '/subscriptions/s/.../subnets/aci',
      } as NodeJS.ProcessEnv)!
    );
    expect(p.client.subnet_id).toBe('/subscriptions/s/.../subnets/aci');
  });
});
