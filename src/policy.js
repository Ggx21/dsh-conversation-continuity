/** Match the host's exact provider/model policy before choosing the summarizer. */
export function summaryPolicy(config, agent) {
  const latest = agent.session.requestHeader()?.config;
  const fallback = agent.options.provider && agent.options.model
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined;
  const conversation = latest ?? fallback;
  const override = config.modelPolicies.find(policy => (
    policy.provider === conversation?.provider && policy.model === conversation?.model
  ));
  const provider = override?.summarizationProvider ?? config.summarizationProvider;
  const model = override?.summarizationModel ?? config.summarizationModel;
  if (!provider && !conversation) throw new Error('No model route is available for conversation compaction');
  return {
    provider: provider || conversation.provider,
    model: provider ? model : conversation.model,
    maxTokens: override?.maxTokens ?? config.maxTokens,
  };
}
