/**
 * @fileoverview Static guard for the Claude Code plugin the repo publishes about itself.
 *
 * `.claude-plugin/marketplace.json` at the repo root makes `/plugin marketplace add
 * Ark0N/Codeman` work, and the one plugin it lists is the repo itself (`source: "./"`),
 * so the plugin's component roots ARE the repo root. Two things follow and both are
 * pinned here: the manifests must carry package.json's version (Claude Code's
 * `plugin update` only sees a release when that number changes; `version-packages`
 * runs `scripts/sync-plugin-version.mjs` to keep them in step), and the repo root
 * must not grow any other plugin component (`commands/`, `agents/`, `hooks/`,
 * `.mcp.json`, `.lsp.json`, `settings.json`), or every plugin install would silently
 * ship it. The skill's frontmatter `name` is pinned too: without it the installed
 * skill would be named after the cache directory, which is a version string.
 *
 * `claude plugin validate .claude-plugin/plugin.json` passes with one warning, that CLAUDE.md at
 * the plugin root is not loaded as plugin context. That is what a repo-root plugin looks like,
 * not a defect; `--strict` is therefore not the right mode for this repo.
 *
 * Pure filesystem reads against the real tree. Port: N/A.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const readJson = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const pkg = readJson('package.json');
const plugin = readJson('.claude-plugin/plugin.json');
const marketplace = readJson('.claude-plugin/marketplace.json');

describe('Claude Code plugin manifests', () => {
  it('plugin.json names the codeman plugin at the package version', () => {
    expect(plugin.name).toBe('codeman');
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.license).toBe('MIT');
    expect(plugin.repository).toBe('https://github.com/Ark0N/Codeman');
  });

  it('marketplace.json lists exactly that plugin, sourced from the repo root, at the same version', () => {
    expect(marketplace.name).toBe('codeman');
    expect(marketplace.owner?.name).toBeTruthy();
    expect(marketplace.plugins).toHaveLength(1);
    const [entry] = marketplace.plugins;
    expect(entry.name).toBe(plugin.name);
    expect(entry.source).toBe('./');
    expect(entry.version).toBe(pkg.version);
  });

  it('the skill declares its own name, so the installed skill is codeman:codeman and not a cache-dir version string', () => {
    const skill = readFileSync(join(ROOT, 'skills/codeman/SKILL.md'), 'utf8');
    const frontmatter = skill.split('---')[1] ?? '';
    expect(frontmatter).toMatch(/^name: codeman$/m);
  });

  it('the repo root carries no other plugin component the install would ship', () => {
    for (const rel of ['commands', 'agents', 'hooks', '.mcp.json', '.lsp.json', 'settings.json', 'monitors']) {
      expect(existsSync(join(ROOT, rel)), `${rel} at the repo root would become part of the plugin`).toBe(false);
    }
    // The manifest must not redirect component discovery either; the defaults are the contract.
    for (const key of ['skills', 'commands', 'agents', 'hooks', 'mcpServers', 'lspServers']) {
      expect(plugin[key], `plugin.json "${key}" override`).toBeUndefined();
    }
  });
});
