import { computed } from 'nanostores';

import { $agentStatuses, $agentXTerms } from '@/renderer/services/agent-process';
import type { AgentProcessStatus, WithTimestamp } from '@/shared/types';

const CHAT_PROCESS_ID = 'chat';

/** Chat process status — derived view into the shared agent statuses map. */
export const $chatProcessStatus = computed($agentStatuses, (statuses): WithTimestamp<AgentProcessStatus> => {
  return statuses[CHAT_PROCESS_ID] ?? { type: 'uninitialized', timestamp: Date.now() };
});

/** Chat xterm — derived view into the shared agent xterms map. */
export const $chatProcessXTerm = computed($agentXTerms, (xterms) => {
  return xterms[CHAT_PROCESS_ID] ?? null;
});
