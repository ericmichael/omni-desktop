import { useStore } from '@nanostores/react';
import { memo, useMemo } from 'react';

import utrgvLogo from '@/renderer/assets/logo-uthealthrgv.jpg';
import { OmniMark } from '@/renderer/common/OmniMark';
import { cn } from '@/renderer/ds/cn';
import { persistedStoreApi } from '@/renderer/services/store';

const ASCII_CHARS: Record<string, [string, string, string]> = {
  ' ': ['   ', '   ', '   '],
  '0': ['█▀█ ', '█ █ ', '▀▀▀ '],
  '1': ['▄█ ', ' █ ', ' ▀ '],
  '2': ['▀▀█ ', '█▀▀ ', '▀▀▀ '],
  '3': ['▀▀█ ', '▀▀█ ', '▀▀▀ '],
  '4': ['█ █ ', '▀▀█ ', '  ▀ '],
  '5': ['█▀▀ ', '▀▀█ ', '▀▀▀ '],
  '6': ['█   ', '█▀█ ', '▀▀▀ '],
  '7': ['▀▀█ ', ' █▀ ', ' ▀  '],
  '8': ['█▀█ ', '█▀█ ', '▀▀▀ '],
  '9': ['█▀█ ', '▀▀█ ', '▀▀▀ '],
  A: ['█▀█ ', '█▀█ ', '▀ ▀ '],
  B: ['█▀▄ ', '█▀▄ ', '▀▀  '],
  C: ['█▀▀ ', '█   ', '▀▀▀ '],
  D: ['█▀▄ ', '█ █ ', '▀▀  '],
  E: ['█▀▀ ', '█▀▀ ', '▀▀▀ '],
  F: ['█▀▀ ', '█▀  ', '▀   '],
  G: ['█▀▀ ', '█ █ ', '▀▀▀ '],
  H: ['█ █ ', '█▀█ ', '▀ ▀ '],
  I: ['█ ', '█ ', '▀ '],
  J: ['  █ ', '▄ █ ', '▀▀▀ '],
  K: ['█ █ ', '█▀▄ ', '▀ ▀ '],
  L: ['█   ', '█   ', '▀▀▀ '],
  M: ['█▀▄▀█ ', '█ ▀ █ ', '▀   ▀ '],
  N: ['█▄ █ ', '█ ▀█ ', '▀  ▀ '],
  O: ['█▀█ ', '█ █ ', '▀▀▀ '],
  P: ['█▀█ ', '█▀▀ ', '▀   '],
  Q: ['█▀█ ', '█ █ ', '▀▀█ '],
  R: ['█▀█ ', '██▄ ', '▀ ▀ '],
  S: ['█▀▀ ', '▀▀█ ', '▀▀▀ '],
  T: ['▀█▀ ', ' █  ', ' ▀  '],
  U: ['█ █ ', '█ █ ', '▀▀▀ '],
  V: ['█ █ ', '█ █ ', ' ▀  '],
  W: ['█ █ █ ', '█ █ █ ', '▀▀▀▀▀ '],
  X: ['█ █ ', '▄▀▄ ', '▀ ▀ '],
  Y: ['█ █ ', '▀█▀ ', ' ▀  '],
  Z: ['▀▀█ ', '▄▀  ', '▀▀▀ '],
};

function createASCIIArt(text: string): string[] {
  const upper = text.toUpperCase();
  let line1 = '';
  let line2 = '';
  let line3 = '';

  for (const char of upper) {
    const pattern = ASCII_CHARS[char];
    if (pattern) {
      line1 += pattern[0];
      line2 += pattern[1];
      line3 += pattern[2];
    }
  }

  return [line1.trimEnd(), line2.trimEnd(), line3.trimEnd()];
}

export const AsciiLogo = memo(({ text = 'OMNI', className }: { text?: string; className?: string }) => {
  const store = useStore(persistedStoreApi.$atom);
  const lines = useMemo(() => createASCIIArt(text), [text]);

  if (store.theme === 'utrgv') {
    return (
      <div className={cn('flex items-center gap-3 select-none', className)}>
        <img src={utrgvLogo} alt="UTHealth RGV" className="h-8" />
        <pre
          role="img"
          aria-label={text}
          className="ascii-logo-text translate-y-px font-mono leading-none text-foreground/70"
        >
          {lines.join('\n')}
        </pre>
      </div>
    );
  }

  return (
    <pre
      role="img"
      aria-label={text}
      className={cn(
        'ascii-logo-text omni-ascii-gradient bg-clip-text font-mono leading-none text-transparent select-none',
        className
      )}
    >
      {lines.join('\n')}
    </pre>
  );
});
AsciiLogo.displayName = 'AsciiLogo';

const OMNI_LINES = createASCIIArt('OMNI');

export const OmniLogo = memo(({ className }: { className?: string }) => {
  const store = useStore(persistedStoreApi.$atom);

  // Branded (UTRGV) wordmark follows the active surface foreground.
  if (store.theme === 'utrgv') {
    return (
      <pre
        role="img"
        aria-label="Omni"
        className={cn('omni-logo-text font-mono leading-none text-foreground/80 select-none', className)}
      >
        {OMNI_LINES.join('\n')}
      </pre>
    );
  }

  return <OmniMark className={cn('select-none', className)} />;
});
OmniLogo.displayName = 'OmniLogo';

/** Boot-time console easter egg — the old ASCII wordmark's retirement home. */
export function logAsciiWordmark(): void {
  console.log(`%c${OMNI_LINES.join('\n')}`, 'color:#5ac8fa; font-family:monospace; line-height:1.2');
}
