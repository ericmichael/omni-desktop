import type { ITheme } from '@xterm/xterm';
import { useMemo } from 'react';

const getCssVar = (name: string): string => {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
};

export const useXTermTheme = (): ITheme => {
  return useMemo((): ITheme => {
    return {
      background: 'rgba(0, 0, 0, 0)',
      foreground: getCssVar('--xterm-fg'),
      black: getCssVar('--xterm-black'),
      brightBlack: getCssVar('--xterm-bright-black'),
      white: getCssVar('--xterm-white'),
      brightWhite: getCssVar('--xterm-bright-white'),
      cursor: getCssVar('--xterm-cursor'),
      cursorAccent: getCssVar('--xterm-cursor-accent'),
      blue: getCssVar('--xterm-blue'),
      brightBlue: getCssVar('--xterm-bright-blue'),
      cyan: getCssVar('--xterm-cyan'),
      brightCyan: getCssVar('--xterm-bright-cyan'),
      green: getCssVar('--xterm-green'),
      brightGreen: getCssVar('--xterm-bright-green'),
      yellow: getCssVar('--xterm-yellow'),
      brightYellow: getCssVar('--xterm-bright-yellow'),
      red: getCssVar('--xterm-red'),
      brightRed: getCssVar('--xterm-bright-red'),
      magenta: getCssVar('--xterm-magenta'),
      brightMagenta: getCssVar('--xterm-bright-magenta'),
    };
  }, []);
};
