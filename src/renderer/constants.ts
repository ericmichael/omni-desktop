import type { ITerminalInitOnlyOptions, ITerminalOptions, ITheme } from '@xterm/xterm';
import { atom } from 'nanostores';

/**
 * The interval in milliseconds to poll the status of a process.
 */
export const STATUS_POLL_INTERVAL_MS = 1_000;

export const TERMINAL_FONT = 'JetBrainsMonoNerdFont';
export const TERMINAL_FONT_SIZE = 12;

export const DEFAULT_XTERM_OPTIONS: ITerminalOptions & ITerminalInitOnlyOptions = {
  cursorBlink: false,
  cursorStyle: 'block',
  fontSize: TERMINAL_FONT_SIZE,
  fontFamily: TERMINAL_FONT,
  scrollback: 5_000,
  allowTransparency: true,
};

const getCssVar = (name: string): string => {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
};

export const $XTERM_THEME = atom<ITheme>({});

export const syncTheme = () => {
  $XTERM_THEME.set({
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
  });
};
