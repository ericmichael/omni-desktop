/**
 * PWA install affordance (UI/UX gameplan Phase 8). Chromium fires
 * `beforeinstallprompt` when the app is installable; we stash the event so
 * Settings can offer a real "Install app" action instead of relying on the
 * browser's omnibox hint. Browsers without the event (Safari, Firefox — and
 * Electron, where it's meaningless) simply never show the affordance.
 */
import { atom } from 'nanostores';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

export const $installPrompt = atom<BeforeInstallPromptEvent | null>(null);

let started = false;

/** Idempotent; wired from the App shell. */
export const initPwaInstall = (): void => {
  if (started) {
    return;
  }
  started = true;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    $installPrompt.set(event as BeforeInstallPromptEvent);
  });
  window.addEventListener('appinstalled', () => {
    $installPrompt.set(null);
  });
};

export const promptInstall = async (): Promise<void> => {
  const prompt = $installPrompt.get();
  if (!prompt) {
    return;
  }
  await prompt.prompt();
  const choice = await prompt.userChoice;
  if (choice.outcome === 'accepted') {
    $installPrompt.set(null);
  }
};
