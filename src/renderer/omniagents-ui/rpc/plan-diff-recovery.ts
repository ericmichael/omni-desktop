import type { MessageItem } from '@/shared/chat-types';

import { adaptCanonicalConversationItem } from './canonical-chat-history';
import type { ConversationClient } from './conversation';
import type { PlanResult, PlansAndDiffsClient, RunDiffResult } from './plans-and-diffs';

type PlanReader = Pick<PlansAndDiffsClient, 'getPlan' | 'getRunDiff'>;
type ItemReader = Pick<ConversationClient, 'getItem'>;

/**
 * Authoritative recovery boundary for the plans-and-diffs feature. The
 * protocol-specific reads identify the durable item, then `get_item` supplies
 * its canonical sequence/envelope so live, replayed, and recovered items all
 * converge through the chat machine's revision-aware merge.
 */
export class PlanDiffRecovery {
  constructor(
    private readonly plans: PlanReader,
    private readonly conversations: ItemReader,
    private readonly supported: () => boolean
  ) {}

  async recoverPlans(threadId: string): Promise<MessageItem[]> {
    if (!this.supported()) {
      return [];
    }
    const result = await this.plans.getPlan(threadId);
    const ids = this.planItemIds(result);
    return Promise.all(ids.map((itemId) => this.readCanonical(threadId, itemId)));
  }

  async recoverLatestRunDiff(threadId: string): Promise<MessageItem[]> {
    return this.recoverRunDiffResult(threadId, await this.readRunDiff(threadId));
  }

  async recoverRunDiff(threadId: string, turnId: string): Promise<MessageItem[]> {
    return this.recoverRunDiffResult(threadId, await this.readRunDiff(threadId, turnId));
  }

  private async readRunDiff(threadId: string, turnId?: string): Promise<RunDiffResult | null> {
    if (!this.supported()) {
      return null;
    }
    return this.plans.getRunDiff(threadId, turnId);
  }

  private async recoverRunDiffResult(threadId: string, result: RunDiffResult | null): Promise<MessageItem[]> {
    if (!result?.run_diff) {
      return [];
    }
    return [await this.readCanonical(threadId, result.run_diff.item_id)];
  }

  private planItemIds(result: PlanResult): string[] {
    return [...new Set([...result.plans, ...(result.plan ? [result.plan] : [])].map((plan) => plan.item_id))];
  }

  private async readCanonical(threadId: string, itemId: string): Promise<MessageItem> {
    const item = await this.conversations.getItem(threadId, itemId);
    return adaptCanonicalConversationItem(item);
  }
}
