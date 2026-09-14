#!/usr/bin/env node
/**
 * @fileoverview Keep the Claude Code plugin manifests in step with package.json.
 *
 * The repo is its own plugin marketplace (`/plugin marketplace add Ark0N/Codeman`
 * reads `.claude-plugin/marketplace.json` from the repo root, and the `codeman`
 * plugin it lists is the repo itself, `source: "./"`, whose one skill is
 * `skills/codeman/`). Claude Code's `plugin update` only sees a new release when
 * the manifest version number changes, so both manifests must carry the version
 * `package.json` carries. This runs inside `npm run version-packages`, right after
 * `changeset version` bumps package.json, and `test/plugin-manifest.test.ts` pins
 * the result so drift fails the gate.
 *
 *   node scripts/sync-plugin-version.mjs          rewrite both manifests
 *   node scripts/sync-plugin-version.mjs --check  exit 1 on drift, change nothing
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PLUGIN_NAME = 'codeman';
const MANIFESTS = ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'];

const check = process.argv.includes('--check');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
let drift = [];

for (const file of MANIFESTS) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const targets = file.endsWith('marketplace.json')
    ? json.plugins.filter((p) => p.name === PLUGIN_NAME)
    : [json];
  if (targets.length === 0) {
    console.error(`${file}: no plugin entry named "${PLUGIN_NAME}"`);
    process.exit(1);
  }
  for (const target of targets) {
    if (target.version !== version) {
      drift.push(`${file}: ${target.version} -> ${version}`);
      target.version = version;
    }
  }
  if (!check) writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}

if (drift.length === 0) {
  console.log(`plugin manifests already at ${version}`);
} else if (check) {
  console.error(`plugin manifest version drift (run: node scripts/sync-plugin-version.mjs):\n  ${drift.join('\n  ')}`);
  process.exit(1);
} else {
  console.log(`plugin manifests synced to ${version}:\n  ${drift.join('\n  ')}`);
}
