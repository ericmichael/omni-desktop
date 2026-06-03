import type { Locator, Page, TestInfo } from '@playwright/test';

export const visualProofEnabled = process.env.VISUAL_PROOF === '1';

type ProofTarget = Page | Locator;

type AttachProofOptions = {
  fullPage?: boolean;
  animations?: 'allow' | 'disabled';
  caret?: 'hide' | 'initial';
};

function safeProofName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'proof'
  );
}

export async function attachProofScreenshot(
  target: ProofTarget,
  testInfo: TestInfo,
  name: string,
  options: AttachProofOptions = {}
): Promise<string | null> {
  if (!visualProofEnabled) {
    return null;
  }

  const filename = `${safeProofName(name)}.png`;
  const path = testInfo.outputPath(filename);
  await target.screenshot({
    path,
    fullPage: 'context' in target ? options.fullPage : undefined,
    animations: options.animations ?? 'disabled',
    caret: options.caret ?? 'hide',
  });
  await testInfo.attach(name, { path, contentType: 'image/png' });
  return path;
}

export async function attachProofVideo(
  testInfo: TestInfo,
  name: string,
  path: string | null | undefined
): Promise<void> {
  if (!visualProofEnabled || !path) {
    return;
  }

  await testInfo.attach(name, { path, contentType: 'video/webm' });
}
