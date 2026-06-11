/**
 * The single place provider-validation failures become words. Tone rules:
 * say what happened in the user's terms, then what to do next — never
 * status codes or protocol nouns.
 */
import type { ProviderProbeResult } from '@/shared/types';

export function probeFailureCopy(providerLabel: string, result: Extract<ProviderProbeResult, { ok: false }>): string {
  switch (result.code) {
    case 'unauthorized':
      return `That key doesn't look right — check it was copied completely, then try again.`;
    case 'network':
      return `Couldn't reach ${providerLabel} — check your internet connection and try again.`;
    case 'not-found':
      return `${providerLabel} answered, but not where we expected — double-check the address.`;
    case 'unknown':
      return `Something unexpected came back from ${providerLabel}. Try again in a moment.`;
  }
}
