import { afterEach, expect, it } from 'vitest';

import { $hoveredVoiceScope, resolveCodeVoiceScope } from './voice-recording';

afterEach(() => {
  $hoveredVoiceScope.set(null);
  document.body.innerHTML = '';
});

it('targets keyboard focus before hover or a previously active tile', () => {
  document.body.innerHTML = '<section data-voice-scope="A"><textarea></textarea></section>';
  document.querySelector('textarea')!.focus();
  $hoveredVoiceScope.set('B');
  expect(resolveCodeVoiceScope('C')).toBe('A');
});

it('falls back to hovered then active tile when no composer owns focus', () => {
  $hoveredVoiceScope.set('B');
  expect(resolveCodeVoiceScope('C')).toBe('B');
  $hoveredVoiceScope.set(null);
  expect(resolveCodeVoiceScope('C')).toBe('C');
});
