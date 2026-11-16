import { BlockAssembler, contentHasImage, LlmError } from '@deepseek-ai/dsh-llm';
import { CONVERSATION_COMPACTION_INSTRUCTION, SUMMARY_HEADINGS } from './prompts.js';
import { summaryPolicy } from './policy.js';

/** Use one host LLM call with the original replay prefix and tool declarations. */
export async function summarizeConversation(ctx, config, input, agent, signal) {
  const target = summaryPolicy(config, agent);
  const assembler = new BlockAssembler();
  const options = {
    ...target,
    messages: [
      ...input.messages,
      { role: 'user', content: [{ type: 'text', text: CONVERSATION_COMPACTION_INSTRUCTION }] },
    ],
    toolHistory: agent.session.toolHistory(),
    ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
  };
  let finished = false;
  for await (const chunk of ctx.llm.stream(options)) {
    assembler.push(chunk);
    if (chunk.type === 'finish') finished = true;
  }
  if (!finished) throw new Error('Conversation compaction stream ended without a finish event');
  const finish = assembler.finish;
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw LlmError.fromFailure(finish.failure);
  }
  if (finish.kind === 'max-tokens') {
    const error = new Error('Conversation compaction reached its output cap');
    error.code = 'MAX_TOKENS';
    throw error;
  }
  const rawOutput = assembler.blocks();
  if (contentHasImage(rawOutput)) {
    throw new LlmError('Conversation checkpoint contains an image', 'UNSUPPORTED_CONTENT');
  }
  if (rawOutput.some(block => !['text', 'reasoning'].includes(block.type))) {
    throw new Error('Conversation checkpoint contains non-text actions');
  }
  const summary = rawOutput.filter(block => block.type === 'text');
  const text = summary.map(block => block.text).join('\n');
  const lines = text.split(/\r?\n/).map(line => line.trim());
  let previous = -1;
  for (const heading of SUMMARY_HEADINGS) {
    const position = lines.indexOf(heading);
    if (position <= previous) throw new Error('Conversation checkpoint is missing ordered sections');
    previous = position;
  }
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    ...target,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  };
}
