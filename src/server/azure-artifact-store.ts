/**
 * Azure Files artifacts store — the ACI/cloud substrate's `ArtifactStore`.
 *
 * Lives in `src/server/` (not `src/main/`) because it is control-plane-only:
 * the multi-tenant server reads the workspace Azure Files share out-of-band via
 * the storage SDK, with no container access. Artifacts live inside the workspace
 * at `.omni-artifacts/<ticketId>/…` (share-relative), so this reads the same
 * share the ACI sandbox already mounts at `/workspace`. The desktop build never
 * constructs it. Keeping it server-side also keeps the desktop dependency graph
 * free of the optional `@azure/storage-file-share` package.
 */
import { ARTIFACTS_DIRNAME } from '@/lib/artifacts';
import { getMimeType, isTextMime } from '@/lib/mime-types';
import type { ArtifactStore } from '@/main/artifact-store';
import type { ArtifactFileContent, ArtifactFileEntry } from '@/shared/types';

/** Mirror of the preview cap in artifacts-fs — text files larger than this read
 *  back with `textContent: null` (preview-only). */
const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;

// Minimal surface of `@azure/storage-file-share` we use. Declared locally + the
// module imported by a variable specifier so this compiles without the (cloud-
// only) package installed; the import throws a clear error if it's truly absent.
type AzureFileItem = {
  kind: 'file' | 'directory';
  name: string;
  properties?: { contentLength?: number; lastModified?: Date };
};
type AzureFileClient = {
  downloadToBuffer: () => Promise<Buffer>;
  uploadData: (d: Buffer) => Promise<unknown>;
};
type AzureDirClient = {
  createIfNotExists: () => Promise<unknown>;
  getDirectoryClient: (n: string) => AzureDirClient;
  getFileClient: (n: string) => AzureFileClient;
  listFilesAndDirectories: () => AsyncIterable<AzureFileItem>;
};
type AzureShareClient = { getDirectoryClient: (p: string) => AzureDirClient };
type AzureSdk = {
  StorageSharedKeyCredential: new (account: string, key: string) => unknown;
  ShareServiceClient: new (url: string, cred: unknown) => { getShareClient: (name: string) => AzureShareClient };
};

/**
 * Reads/writes the workspace Azure Files share via the storage SDK,
 * control-plane-side — no container access. Keyed `.omni-artifacts/<ticketId>/…`
 * (matching where the in-container agent writes under `/workspace`). Wired into
 * the server build's per-tenant `artifactStoreFor`; the desktop build never
 * constructs it.
 */
export class AzureFilesArtifactStore implements ArtifactStore {
  constructor(private readonly cfg: { account: string; key: string; share: string }) {}

  /** Share-relative root for a ticket's artifacts. */
  private root(ticketId: string): string {
    return `${ARTIFACTS_DIRNAME}/${ticketId}`;
  }

  private async share(): Promise<AzureShareClient> {
    const specifier = '@azure/storage-file-share';
    let sdk: AzureSdk;
    try {
      sdk = (await import(/* @vite-ignore */ specifier)) as unknown as AzureSdk;
    } catch {
      throw new Error('Azure Files artifacts require the @azure/storage-file-share package');
    }
    const cred = new sdk.StorageSharedKeyCredential(this.cfg.account, this.cfg.key);
    const svc = new sdk.ShareServiceClient(`https://${this.cfg.account}.file.core.windows.net`, cred);
    return svc.getShareClient(this.cfg.share);
  }

  async list(ticketId: string, dirPath?: string): Promise<ArtifactFileEntry[]> {
    const dir = `${this.root(ticketId)}${dirPath ? `/${dirPath}` : ''}`;
    const entries: ArtifactFileEntry[] = [];
    try {
      const client = (await this.share()).getDirectoryClient(dir);
      for await (const item of client.listFilesAndDirectories()) {
        entries.push({
          relativePath: dirPath ? `${dirPath}/${item.name}` : item.name,
          name: item.name,
          isDirectory: item.kind === 'directory',
          size: item.properties?.contentLength ?? 0,
          modifiedAt: item.properties?.lastModified?.getTime() ?? 0,
        });
      }
    } catch {
      return []; // missing dir → empty, like the host store
    }
    entries.sort((a, b) => (a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name)));
    return entries;
  }

  async read(ticketId: string, relativePath: string): Promise<ArtifactFileContent> {
    const slash = relativePath.lastIndexOf('/');
    const dir = `${this.root(ticketId)}${slash >= 0 ? `/${relativePath.slice(0, slash)}` : ''}`;
    const name = slash >= 0 ? relativePath.slice(slash + 1) : relativePath;
    const mimeType = getMimeType(relativePath);
    const buf = await (await this.share()).getDirectoryClient(dir).getFileClient(name).downloadToBuffer();
    const textContent = isTextMime(mimeType) && buf.length <= MAX_TEXT_PREVIEW_BYTES ? buf.toString('utf-8') : null;
    return { relativePath, mimeType, textContent, size: buf.length };
  }

  async write(ticketId: string, relativePath: string, data: Buffer): Promise<void> {
    const segs = `${this.root(ticketId)}/${relativePath}`.split('/');
    const name = segs.pop()!;
    // Azure Files has no recursive mkdir — create each directory segment.
    let dir = (await this.share()).getDirectoryClient(segs[0]!);
    await dir.createIfNotExists();
    for (const seg of segs.slice(1)) {
      dir = dir.getDirectoryClient(seg);
      await dir.createIfNotExists();
    }
    await dir.getFileClient(name).uploadData(data);
  }

  async materialize(ticketId: string, relativePath: string): Promise<string | null> {
    // Control-plane-local copy (this is the server's filesystem, not the
    // user's machine — browser clients download over HTTP from here).
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const slash = relativePath.lastIndexOf('/');
    const dir = `${this.root(ticketId)}${slash >= 0 ? `/${relativePath.slice(0, slash)}` : ''}`;
    const name = slash >= 0 ? relativePath.slice(slash + 1) : relativePath;
    try {
      const buf = await (await this.share()).getDirectoryClient(dir).getFileClient(name).downloadToBuffer();
      const tmp = await mkdtemp(join(tmpdir(), 'omni-artifact-'));
      const out = join(tmp, name);
      await writeFile(out, buf);
      return out;
    } catch {
      return null;
    }
  }
}
