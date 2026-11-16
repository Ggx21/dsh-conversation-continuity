import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { CONTINUITY_GUIDANCE } from './src/prompts.js';
import { summarizeConversation } from './src/summarize.js';

export const name = 'conversation-continuity';

/** Keep the host's retention, tool pairing, cancellation and durable transactions. */
export default class ConversationCompactionEngine extends BasicCompactionEngine {
  static inject = [...BasicCompactionEngine.inject, 'systemPrompt'];

  constructor(ctx, config = {}) {
    super(ctx, config);
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'conversation-continuity:guidance',
      order: 11500,
      interpolate: false,
      text: CONTINUITY_GUIDANCE,
    }));
  }

  summarize(input, agent, signal) {
    return summarizeConversation(this.ctx, this.config, input, agent, signal);
  }
}
