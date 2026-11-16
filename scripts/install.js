import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';

const PACKAGE = 'dsh-conversation-continuity';
const OFFICIAL = '@deepseek-ai/dsh-compaction-basic';
const parseOptions = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] };

/** Replace one engine per explicit preset, preserving all other configuration. */
export async function configureProfile(profileDir, { runtimeDir, uninstall = false, dryRun = false } = {}) {
  const patchPath = path.resolve(profileDir, 'cordis.patch.yml');
  const source = await fs.readFile(patchPath, 'utf8');
  const doc = YAML.parseDocument(source, parseOptions);
  if (doc.errors.length || !YAML.isSeq(doc.contents)) throw new Error('Expected a valid profile patch sequence');
  let presets = doc.contents.items.filter(row => row.get?.('id')?.startsWith('preset-'));
  if (presets.length === 0) {
    if (uninstall) return { changed: 0 };
    if (!runtimeDir) throw new Error('No explicit agent presets. Supply --runtime-dir pointing to the host node_modules directory');
    const require = createRequire(path.resolve(runtimeDir, '__continuity_resolve.cjs'));
    const hostPackage = require.resolve('@deepseek-ai/dsh-web-app/package.json');
    const presetsDir = path.join(path.dirname(hostPackage), 'presets');
    for (const name of ['standard', 'cordis', 'ptc', 'minimal']) {
      const template = YAML.parseDocument(await fs.readFile(path.join(presetsDir, name + '.patch.yml'), 'utf8'), parseOptions);
      if (template.errors.length) throw new Error('Invalid host preset template');
      const original = template.contents.items.flatMap(row => row.get('insert')?.items ?? [])
        .find(row => row.get('id') === 'preset-' + name);
      if (!original) throw new Error('Host preset template is missing its preset entry');
      const preset = doc.createNode({ id: 'preset-' + name, config: { id: name } });
      preset.setIn(['config', 'plugins'], original.getIn(['config', 'plugins']).clone());
      doc.contents.add(preset);
    }
    presets = doc.contents.items.filter(row => row.get?.('id')?.startsWith('preset-'));
  }
  const from = uninstall ? PACKAGE : OFFICIAL;
  const to = uninstall ? OFFICIAL : PACKAGE;
  let changed = 0;
  for (const preset of presets) {
    const plugins = preset.getIn(['config', 'plugins']);
    if (!YAML.isSeq(plugins)) throw new Error('Preset has no explicit plugins list. Materialize it before installing');
    const group = plugins.items.find(row => row.get('id') === 'compaction');
    const engine = group?.get('config')?.items.find(row => row.get('id') === 'compaction-basic');
    if (!engine) throw new Error('Preset is missing the official compaction-basic slot');
    const current = engine.get('name');
    if (current === to) continue;
    if (current !== from) throw new Error('Preset uses another compaction backend. Configure it explicitly');
    engine.set('name', to);
    changed += 1;
  }
  if (changed === 0 || dryRun) return { changed, dryRun };
  const backup = patchPath + '.before-continuity-' + Date.now() + '-' + randomUUID();
  await fs.writeFile(backup, source, { mode: 0o600, flag: 'wx' });
  const temporary = patchPath + '.continuity-' + randomUUID();
  try {
    await fs.writeFile(temporary, doc.toString({ lineWidth: 0 }), { mode: 0o600, flag: 'wx' });
    if (await fs.readFile(patchPath, 'utf8') !== source) {
      throw new Error('Profile changed during installation. Retry after the other edit finishes');
    }
    await fs.rename(temporary, patchPath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return { changed, backup };
}

if (process.argv[1] && await fs.realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      'profile-dir': { type: 'string' },
      'runtime-dir': { type: 'string' },
      uninstall: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    } });
    if (!values['profile-dir']) throw new Error('Supply --profile-dir with an existing DSH profile directory');
    console.log(JSON.stringify(await configureProfile(values['profile-dir'], {
      runtimeDir: values['runtime-dir'], uninstall: values.uninstall, dryRun: values['dry-run'],
    })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
