import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { summaryPolicy } from '../src/policy.js';
import { summarizeConversation } from '../src/summarize.js';
import { SUMMARY_HEADINGS } from '../src/prompts.js';
import { configureProfile } from '../scripts/install.js';

const config = { summarizationProvider: '', summarizationModel: '', maxTokens: 4096, modelPolicies: [] };
const agent = {
  options: { provider: 'fallback', model: 'fallback-model' },
  session: {
    id: 'synthetic-session',
    requestHeader: () => ({ config: { provider: 'current', model: 'current-model' } }),
    toolHistory: () => ({ tools: [], updates: [] }),
  },
};
const checkpoint = SUMMARY_HEADINGS.map(heading => heading + '\n- 合成测试材料').join('\n\n');

function streamContext(text = checkpoint, finish = { kind: 'stop' }, extra = []) {
  const calls = [];
  return {
    calls,
    llm: {
      async *stream(options) {
        calls.push(options);
        yield { type: 'reasoning-delta', index: 0, text: 'synthetic reasoning' };
        yield { type: 'text-delta', index: 1, text };
        yield* extra;
        yield { type: 'usage', usage: { inputTokens: 200, outputTokens: 80 } };
        if (finish) yield { type: 'finish', reason: finish };
      },
    },
  };
}

test('uses the latest conversation route and its exact model policy', () => {
  assert.deepEqual(summaryPolicy({ ...config, modelPolicies: [{
    provider: 'current', model: 'current-model',
    summarizationProvider: 'summary', summarizationModel: 'summary-model', maxTokens: 2048,
  }] }, agent), { provider: 'summary', model: 'summary-model', maxTokens: 2048 });
});

test('explicit summary route works before any conversation route exists', () => {
  const blank = { options: {}, session: { requestHeader: () => undefined } };
  assert.deepEqual(summaryPolicy({ ...config, summarizationProvider: 'summary', summarizationModel: 'small' }, blank), {
    provider: 'summary', model: 'small', maxTokens: 4096,
  });
  assert.throws(() => summaryPolicy(config, blank), /No model route/);
});

test('an exact override can return from a configured summary model to the conversation model', () => {
  const policy = summaryPolicy({ ...config, summarizationProvider: 'summary', summarizationModel: 'small',
    modelPolicies: [{ provider: 'current', model: 'current-model', summarizationProvider: '', summarizationModel: '' }],
  }, agent);
  assert.equal(policy.provider, 'current');
  assert.equal(policy.model, 'current-model');
});

test('one call preserves the full replay prefix, tools, tool history and abort signal', async () => {
  const ctx = streamContext();
  const messages = Object.freeze([{ role: 'system', content: [{ type: 'text', text: 'synthetic persona' }] }]);
  const tools = Object.freeze([{ name: 'synthetic_tool', description: 'fixture', parameters: {} }]);
  const controller = new AbortController();
  const result = await summarizeConversation(ctx, config, { messages, tools }, agent, controller.signal);
  assert.equal(ctx.calls.length, 1);
  const call = ctx.calls[0];
  assert.equal(call.messages[0], messages[0]);
  assert.equal(call.messages.length, messages.length + 1);
  assert.deepEqual(call.tools, tools);
  assert.equal(call.signal, controller.signal);
  assert.equal(call.sessionId, agent.session.id);
  assert.equal(call.purpose, 'compaction');
  assert.deepEqual(result.summary, [{ type: 'text', text: checkpoint }]);
  assert.equal(result.rawOutput[0].type, 'reasoning');
  assert.equal(result.usage.outputTokens, 80);
  assert.equal(result.llmStreamCall, true);
});

test('truncated checkpoints keep the host MAX_TOKENS failure code', async () => {
  await assert.rejects(summarizeConversation(streamContext(checkpoint, { kind: 'max-tokens' }), config, { messages: [] }, agent), {
    code: 'MAX_TOKENS',
  });
});

test('interrupted streams cannot land a checkpoint', async () => {
  await assert.rejects(summarizeConversation(streamContext(checkpoint, null), config, { messages: [] }, agent), /without a finish/);
});

test('missing or reordered checkpoint sections are rejected', async () => {
  for (const text of ['hello', [...SUMMARY_HEADINGS].reverse().join('\n')]) {
    await assert.rejects(summarizeConversation(streamContext(text), config, { messages: [] }, agent), /ordered sections/);
  }
});

test('summary tool calls cannot be committed as conversation memory', async () => {
  const extra = [{ type: 'block-end', index: 2, block: { type: 'tool-call', id: 'synthetic-call', name: 'write', arguments: '{}' } }];
  await assert.rejects(summarizeConversation(streamContext(checkpoint, { kind: 'tool-calls' }, extra), config, { messages: [] }, agent), /non-text actions/);
});

const profileSource = `- id: im-qqbot
  config: {appSecret: synthetic-secret, requireMention: false}
- id: preset-standard
  config:
    id: standard
    plugins:
      - id: tool-fixture
        config: {value: !!js "() => 1"}
      - id: compaction
        config:
          - id: compaction-basic
            name: '@deepseek-ai/dsh-compaction-basic'
            config: {thresholdRatio: 0.12, retainTokens: 32000, auto: true}
          - id: tool-result-pruner
            config: {thresholdChars: 6000}
`;
const yamlOptions = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] };

async function temporaryProfile(t, source = profileSource) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-continuity-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'cordis.patch.yml'), source);
  return directory;
}

test('installation preserves credentials, JS tags, tools and compaction settings', async t => {
  const directory = await temporaryProfile(t);
  const result = await configureProfile(directory);
  assert.equal(result.changed, 1);
  assert.equal(await readFile(result.backup, 'utf8'), profileSource);
  const source = await readFile(path.join(directory, 'cordis.patch.yml'), 'utf8');
  assert.match(source, /!!js/);
  const actual = YAML.parseDocument(source, yamlOptions).toJS();
  const expected = YAML.parseDocument(profileSource, yamlOptions).toJS();
  expected[1].config.plugins[1].config[0].name = 'dsh-conversation-continuity';
  assert.deepEqual(actual, expected);
  assert.equal((await configureProfile(directory)).changed, 0);
  await configureProfile(directory, { uninstall: true });
  assert.deepEqual(YAML.parseDocument(await readFile(path.join(directory, 'cordis.patch.yml'), 'utf8'), yamlOptions).toJS(),
    YAML.parseDocument(profileSource, yamlOptions).toJS());
});

test('a dry run performs no writes', async t => {
  const directory = await temporaryProfile(t);
  assert.equal((await configureProfile(directory, { dryRun: true })).changed, 1);
  assert.deepEqual(await readdir(directory), ['cordis.patch.yml']);
  assert.equal(await readFile(path.join(directory, 'cordis.patch.yml'), 'utf8'), profileSource);
});

test('the installer CLI works through a package manager directory link', async t => {
  const directory = await temporaryProfile(t);
  const alias = path.join(directory, 'package-link');
  const repository = fileURLToPath(new URL('../', import.meta.url));
  await symlink(repository, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const { stdout } = await promisify(execFile)(process.execPath, [
    path.join(alias, 'scripts/install.js'), '--profile-dir', directory, '--dry-run',
  ]);
  assert.equal(JSON.parse(stdout).changed, 1);
  assert.equal(await readFile(path.join(directory, 'cordis.patch.yml'), 'utf8'), profileSource);
});

test('another backend or a partial preset is rejected without mutating the profile', async t => {
  for (const source of [profileSource.replace('@deepseek-ai/dsh-compaction-basic', 'another-backend'), '- id: preset-standard\n  config: {id: standard}\n']) {
    const directory = await temporaryProfile(t, source);
    await assert.rejects(configureProfile(directory));
    assert.equal(await readFile(path.join(directory, 'cordis.patch.yml'), 'utf8'), source);
  }
});
