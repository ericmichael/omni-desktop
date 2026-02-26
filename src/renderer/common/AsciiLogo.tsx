import { useStore } from '@nanostores/react';
import { memo, useMemo } from 'react';

import utrgvLogo from '@/renderer/assets/logo-uthealthrgv.jpg';
import { cn } from '@/renderer/ds';
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
        <pre className="leading-none text-[8px] font-mono text-white/70 translate-y-px">{lines.join('\n')}</pre>
      </div>
    );
  }

  return (
    <pre
      className={cn(
        'leading-none text-[8px] font-mono select-none bg-gradient-to-r from-[#bb9af7] to-[#7aa2f7] bg-clip-text text-transparent',
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

  return (
    <pre
      className={cn(
        'leading-none text-[6px] font-mono select-none',
        store.theme === 'utrgv'
          ? 'text-white/80'
          : 'bg-gradient-to-r from-[#bb9af7] to-[#7aa2f7] bg-clip-text text-transparent',
        className
      )}
    >
      {OMNI_LINES.join('\n')}
    </pre>
  );
});
OmniLogo.displayName = 'OmniLogo';
