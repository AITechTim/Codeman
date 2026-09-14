import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HerdrMuxManager, normalizeAgentName, parseHerdrJson, workspaceAlias } from '../src/herdr-mux-manager.js';

const codexAgent = {
  terminal_id: 'term_123',
  pane_id: 'w1:t1:p1',
  workspace_id: 'w1',
  agent: 'codex',
  agent_status: 'working',
  foreground_cwd: '/workspaces/project',
  title: 'Project agent',
  agent_session: { source: 'codex', agent: 'codex', kind: 'uuid', value: 'conversation-123' },
};

function namingFixture(mappingPath = join(mkdtempSync(join(tmpdir(), 'herdr-names-')), 'mappings.json')) {
  const agents: Record<string, unknown>[] = [{ ...codexAgent, name: 'c-generated' }];
  const workspaces = [{ workspace_id: 'w1', label: 'w1-workspaces' }];
  const calls: string[][] = [];
  let failures = 0;
  let workspaceFailures = 0;
  const manager = new HerdrMuxManager({
    mappingPath,
    asyncRunner: async (args) => {
      calls.push(args);
      if (args[0] === 'workspace' && args[1] === 'list') {
        if (workspaceFailures-- > 0) throw new Error('Workspace lookup unavailable');
        return { workspaces: workspaces.map((workspace) => ({ ...workspace })) };
      }
      if (args[0] === 'pane' && args[1] === 'list') {
        // Real pane responses omit the agent name.
        return { panes: agents.map(({ name: _name, ...pane }) => pane) };
      }
      if (args[0] === 'pane' && args[1] === 'rename') return {};
      if (args[0] === 'agent' && args[1] === 'list') return { agents: agents.map((agent) => ({ ...agent })) };
      if (args[0] === 'agent' && args[1] === 'rename') {
        if (failures-- > 0) throw new Error('Agent moved or exited');
        const agent = agents.find((item) => item.pane_id === args[2]);
        if (!agent) throw new Error('Missing agent');
        if (agents.some((item) => item !== agent && item.name === args[3])) throw new Error('Name taken');
        agent.name = args[3];
        return {};
      }
      throw new Error(`Unexpected call ${args}`);
    },
    syncRunner: (args) => {
      calls.push(args);
      if (args[0] === 'pane' && args[1] === 'rename') return {};
      throw new Error(`Unexpected call ${args}`);
    },
  });
  return {
    manager,
    agents,
    workspaces,
    calls,
    mappingPath,
    failNext: () => {
      failures = 1;
    },
    failWorkspaceLookup: () => {
      workspaceFailures = 1;
    },
  };
}

describe('Herdr agent name synchronization', () => {
  it.each([
    ['w1-workspaces', 'fix-mobile-codeman-voice', 'ws-fix-mobile-codeman-voice'],
    ['w1-knowledge-base', 'explain-active-work-items', 'kb-explain-active-work-items'],
    ['w1-cvision_v01', 'fix-gpu-2-vmic-resolution', 'cv01-fix-gpu-2-vmic-resolution'],
    ['w1-annotation-platform', 'Please investigate the annotation queue', 'ap-investigate-annotation-queue'],
    ['long-workspace-label', 'fix-mobile-codeman-voice-capture', 'long-wor-fix-mobile-codeman'],
  ])('prefixes %s tasks with a bounded shared name', async (label, title, expected) => {
    const { manager, agents, workspaces, calls } = namingFixture();
    workspaces[0].label = label;
    agents[0].title = title;
    await manager.reconcileSessions();
    expect(agents[0].name).toBe(expected);
    expect(manager.getSessions()[0].name).toBe(expected);
    expect(expected).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    calls.length = 0;
    await manager.reconcileSessions();
    expect(calls.filter((args) => args[0] === 'workspace' && args[1] === 'list')).toHaveLength(1);
    expect(calls.some((args) => args[1] === 'rename')).toBe(false);
  });

  it('remembers the group through cwd changes, group renames, moves and restart', async () => {
    const fixture = namingFixture();
    fixture.workspaces[0].label = 'w1-cvision_v01';
    fixture.agents[0].foreground_cwd = '/workspaces/temporary-worktree';
    fixture.agents[0].title = 'Fix viewer';
    await fixture.manager.reconcileSessions();
    const id = fixture.manager.getSessions()[0].sessionId;
    fixture.workspaces[0].label = 'w1-knowledge-base';
    fixture.agents[0].foreground_cwd = '/workspaces/elsewhere';
    fixture.agents[0].workspace_id = 'w9';
    fixture.agents[0].pane_id = 'w9:p4';
    fixture.workspaces.push({ workspace_id: 'w9', label: 'annotation-platform' });
    await fixture.manager.reconcileSessions();
    expect(fixture.agents[0].name).toBe('cv01-fix-viewer');
    const restarted = namingFixture(fixture.mappingPath);
    restarted.agents[0] = { ...fixture.agents[0] };
    restarted.manager.setAgentTitleResolver(async () => new Map([[id, 'Fix mobile viewer']]));
    await restarted.manager.reconcileSessions();
    expect(restarted.agents[0].name).toBe('cv01-fix-mobile-viewer');
    expect(JSON.parse(readFileSync(fixture.mappingPath, 'utf8')).mappings[0]).toMatchObject({
      originWorkspaceId: 'w1',
      originWorkspaceLabel: 'w1-cvision_v01',
      originWorkspaceAlias: 'cv01',
    });
  });

  it('migrates v2 automatic names once without changing identity or manual names', async () => {
    const fixture = namingFixture();
    await fixture.manager.reconcileSessions();
    const saved = JSON.parse(readFileSync(fixture.mappingPath, 'utf8'));
    const mapping = saved.mappings[0];
    mapping.name = mapping.agentName = 'fix-mobile-codeman-voice';
    mapping.agentNameTitle = 'Fix mobile codeman voice';
    mapping.nameVersion = 2;
    delete mapping.originWorkspaceId;
    delete mapping.originWorkspaceLabel;
    delete mapping.originWorkspaceAlias;
    writeFileSync(fixture.mappingPath, JSON.stringify(saved));
    const restarted = namingFixture(fixture.mappingPath);
    restarted.agents[0].name = mapping.name;
    await restarted.manager.reconcileSessions();
    expect(restarted.agents[0].name).toBe('ws-fix-mobile-codeman-voice');
    expect(restarted.manager.getSessions()[0].sessionId).toBe(mapping.sessionId);
    mapping.nameSource = 'manual';
    mapping.manualName = 'my-custom-name';
    writeFileSync(fixture.mappingPath, JSON.stringify(saved));
    const manual = namingFixture(fixture.mappingPath);
    await manual.manager.reconcileSessions();
    expect(manual.agents[0].name).toBe('my-custom-name');
  });

  it('defers naming on workspace lookup failure and remembers the first group during a move', async () => {
    const fixture = namingFixture();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      fixture.failWorkspaceLookup();
      await fixture.manager.reconcileSessions();
      expect(fixture.agents[0].name).toBe('c-generated');
      fixture.agents[0].workspace_id = 'w9';
      fixture.workspaces.push({ workspace_id: 'w9', label: 'knowledge-base' });
      await fixture.manager.reconcileSessions();
      expect(fixture.agents[0].name).toBe('ws-project-agent');
      const id = fixture.manager.getSessions()[0].sessionId;
      fixture.manager.setAgentTitleResolver(async () => new Map([[id, 'Changed title']]));
      fixture.failWorkspaceLookup();
      await fixture.manager.reconcileSessions();
      expect(fixture.agents[0].name).toBe('ws-project-agent');
      await fixture.manager.reconcileSessions();
      expect(fixture.agents[0].name).toBe('ws-changed-title');
    } finally {
      warn.mockRestore();
    }
  });

  it('waits for a missing workspace label instead of using the foreground folder', async () => {
    const { manager, agents, workspaces } = namingFixture();
    workspaces[0].label = '';
    await manager.reconcileSessions();
    expect(agents[0].name).toBe('c-generated');
    workspaces[0].label = 'knowledge-base';
    await manager.reconcileSessions();
    expect(agents[0].name).toBe('kb-project-agent');
  });

  it('retains the prefix and task words when a long name collides', async () => {
    const { manager, agents, workspaces, mappingPath } = namingFixture();
    workspaces[0].label = 'long-workspace-label';
    agents[0].title = 'fix-mobile-codeman-voice-capture';
    agents.push({ ...agents[0], terminal_id: 'duplicate', pane_id: 'w1:p2', name: undefined });
    await manager.reconcileSessions();
    const id = manager.getSessions()[1].sessionId;
    const hash = createHash('sha256').update(id).digest('hex').slice(0, 8);
    expect(agents[1].name).toBe(`long-wor-fix-mobile-${hash}`);
    const restarted = namingFixture(mappingPath);
    restarted.agents.splice(0, restarted.agents.length, { ...agents[1] });
    await restarted.manager.reconcileSessions();
    expect(restarted.agents[0].name).toBe(agents[1].name);
  });

  it('keeps manual names through title updates, stale restoration and manager restarts', async () => {
    const { manager, agents, mappingPath } = namingFixture();
    await manager.reconcileSessions();
    const id = manager.getSessions()[0].sessionId;
    manager.setAgentTitleResolver(async () => new Map([[id, 'Please deploy the latest version']]));
    manager.updateSessionName(id, 'The Plan For A New Release', 'manual');
    await manager.reconcileSessions();
    expect(agents[0].name).toBe('the-plan-for-a-new-release');
    expect(manager.getSession(id)?.name).toBe(agents[0].name);
    const restored = namingFixture(mappingPath);
    restored.agents[0] = { ...agents[0] };
    restored.manager.setAgentTitleResolver(async () => new Map([[id, 'An entirely different conversation']]));
    await restored.manager.reconcileSessions();
    restored.manager.updateSessionName(id, 'outdated saved state');
    await restored.manager.reconcileSessions();
    expect(restored.agents[0].name).toBe('the-plan-for-a-new-release');
    expect(restored.manager.getSession(id)?.name).toBe('the-plan-for-a-new-release');
    expect(JSON.parse(readFileSync(mappingPath, 'utf8')).mappings[0].nameSource).toBe('manual');
  });

  it('migrates old shortening assignments once even if their source title did not change', async () => {
    const { mappingPath, manager } = namingFixture();
    await manager.reconcileSessions();
    const saved = JSON.parse(readFileSync(mappingPath, 'utf8'));
    const mapping = saved.mappings[0];
    mapping.name = 'w1-project';
    mapping.agentName = 'please-deploy-the-latest-version';
    mapping.agentNameTitle = 'Please deploy the latest version to';
    delete mapping.nameVersion;
    writeFileSync(mappingPath, JSON.stringify(saved));
    const restarted = namingFixture(mappingPath);
    restarted.agents[0].name = mapping.agentName;
    const updated = vi.fn();
    restarted.manager.on('sessionUpdated', updated);
    await restarted.manager.reconcileSessions();
    expect(restarted.agents[0].name).toBe('ws-deploy-latest-version');
    expect(restarted.manager.getSessions()[0].name).toBe('ws-deploy-latest-version');
    expect(updated).toHaveBeenCalled();
    restarted.calls.length = 0;
    await restarted.manager.reconcileSessions();
    expect(restarted.calls.some((args) => args[1] === 'rename')).toBe(false);
  });

  it('publishes short canonical names and retains the last title when an alias is unavailable', async () => {
    const { manager, agents, calls } = namingFixture();
    await manager.reconcileSessions();
    const id = manager.getSessions()[0].sessionId;
    const titles = new Map([[id, 'Review cvision work-items']]);
    manager.setAgentTitleResolver(async () => titles);
    await manager.reconcileSessions();
    expect(agents[0].name).toBe('ws-review-cvision-work-items');
    expect(manager.getSessions()[0].name).toBe('ws-review-cvision-work-items');
    titles.set(id, 'Rename the conversation');
    await manager.reconcileSessions();
    expect(agents[0].name).toBe('ws-rename-conversation');
    titles.clear();
    await manager.reconcileSessions();
    expect(agents[0].name).toBe('ws-rename-conversation');
    const count = calls.length;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      manager.setAgentTitleResolver(async () => {
        throw new Error('Unavailable');
      });
      await manager.reconcileSessions();
      expect(calls.slice(count).some((args) => args[1] === 'rename')).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('migrates legacy names and publishes canonical Codeman titles', async () => {
    const { manager, agents, calls } = namingFixture();
    agents.push({ ...codexAgent, terminal_id: 'term_other', pane_id: 'w2:p1', title: 'Manual Work', name: 'custom' });
    await manager.reconcileSessions();
    expect(agents.map((agent) => agent.name)).toEqual(['ws-project-agent', 'ws-manual-work']);
    const session = manager.getSessions()[0];
    expect(manager.updateSessionName(session.sessionId, 'Fix Login Now', 'manual')).toBe(true);
    await manager.reconcileSessions();
    expect(agents[0].name).toBe('fix-login-now');
    expect(manager.getSession(session.sessionId)?.name).toBe('fix-login-now');
    const renames = calls.filter((args) => args[1] === 'rename').length;
    await manager.reconcileSessions();
    expect(calls.filter((args) => args[1] === 'rename')).toHaveLength(renames);
  });

  it('uses stable collision suffixes across restart and falls back to numbered suffixes', async () => {
    const fixture = namingFixture();
    const { manager, agents, mappingPath } = fixture;
    agents.push({ ...codexAgent, terminal_id: 'term_duplicate', pane_id: 'w2:p1', name: 'custom' });
    // Reserve the hash candidate to exercise the next collision level.
    const sessionId = `herdr-${createHash('sha256').update('term_duplicate').digest('hex').slice(0, 32)}`;
    const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
    const reserved = `ws-project-agent-${hash}`;
    agents.push({ ...codexAgent, terminal_id: 'term_reserved', pane_id: 'w3:p1', title: reserved, name: reserved });
    await manager.reconcileSessions();
    expect(agents[1].name).toBe(`${reserved}-1`);
    const restarted = namingFixture(mappingPath);
    restarted.agents.splice(0, restarted.agents.length, { ...agents[1], name: undefined });
    await restarted.manager.reconcileSessions();
    expect(restarted.agents[0].name).toBe(`${reserved}-1`);
    expect(restarted.manager.getSessions()[0].sessionId).toBe(sessionId);
    restarted.manager.updateSessionName(sessionId, 'Fresh Title', 'manual');
    await restarted.manager.reconcileSessions();
    expect(restarted.agents[0].name).toBe('fresh-title');
  });

  it('retries failed renames and follows terminal identity across pane moves and agent replacement', async () => {
    const { manager, agents, failNext } = namingFixture();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      failNext();
      await manager.reconcileSessions();
      expect(agents[0].name).toBe('c-generated');
      expect(warn).toHaveBeenCalled();
      const id = manager.getSessions()[0].sessionId;
      agents[0].pane_id = 'w9:p4';
      await manager.reconcileSessions();
      expect(agents[0].name).toBe('ws-project-agent');
      agents[0].name = undefined;
      agents[0].agent_session = { value: 'replacement' };
      await manager.reconcileSessions();
      expect(agents[0].name).toBe('ws-project-agent');
      expect(manager.getSessions()[0]).toMatchObject({ sessionId: id, paneId: 'w9:p4' });
    } finally {
      warn.mockRestore();
    }
  });

  it('coalesces overlapping reconciliations and upgrades legacy mappings without changing IDs', async () => {
    const { manager, agents, calls, mappingPath } = namingFixture();
    await Promise.all([manager.reconcileSessions(), manager.reconcileSessions(), manager.reconcileSessions()]);
    expect(calls.filter((args) => args[0] === 'agent' && args[1] === 'rename')).toHaveLength(1);
    const saved = JSON.parse(readFileSync(mappingPath, 'utf8'));
    delete saved.mappings[0].agentName;
    delete saved.mappings[0].agentNameTitle;
    saved.mappings[0].name = 'Saved Tab Title';
    writeFileSync(mappingPath, JSON.stringify(saved));
    const restored = namingFixture(mappingPath);
    restored.agents[0] = { ...agents[0] };
    await restored.manager.reconcileSessions();
    expect(restored.agents[0].name).toBe('ws-saved-tab-title');
    expect(restored.manager.getSessions()[0].sessionId).toBe(saved.mappings[0].sessionId);
  });
});

describe('HerdrMuxManager', () => {
  it.each([
    ['w1-workspaces', 'ws'],
    ['w12-knowledge-base', 'kb'],
    ['cvision_v01', 'cv01'],
    ['w1-cvision_v02', 'cv02'],
    ['annotation-platform', 'ap'],
    ['My Project', 'my-proje'],
    ['abcdefgh-more', 'abcdefgh'],
    ['abc----!', 'abc'],
    ['123', 'w-123'],
    ['', 'ws'],
    ['日本語', 'ws'],
  ])('aliases workspace %j as %s', (label, expected) => {
    expect(workspaceAlias(label)).toBe(expected);
  });
  it.each([
    ['Please deploy the latest version to', 'deploy-latest-version'],
    ['Can you compare the ingestion level', 'compare-ingestion-level'],
    ['Would be nice if Herdr agents could', 'herdr-agents'],
    ['Would be nice of Herdr agents could', 'herdr-agents'],
    ['Review Matrixreq docs for ISO 13485', 'review-matrixreq-docs-iso'],
    ['Never delete the data', 'never-delete-data'],
    ["Didn't we implement .vmic handling?", 'didnt-implement-vmic-handling'],
    ["Please don't delete data", 'dont-delete-data'],
    ['Review python into_parser the-api work-items now', 'review-python-into_parser'],
    ['Check the-api into_parser', 'check-the-api-into_parser'],
    ['please the to', 'please-the-to'],
    ['this is a verylongidentifierthatexceedsthemaximumlength', 'verylongidentifierthatexceedsthe'],
    ['Fix Login', 'fix-login'],
    ['__123 Issues!!', 'agent-123-issues'],
    ['', 'agent'],
    ['日本語 🚀', 'agent'],
    ['Fix___LOGIN', 'fix___login'],
    ['a'.repeat(40), 'a'.repeat(32)],
    ['a'.repeat(31) + ' words', 'a'.repeat(31)],
  ])('normalizes %j into a valid agent name', (title, expected) => {
    expect(normalizeAgentName(title)).toBe(expected);
    expect(normalizeAgentName(title)).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });

  it('unwraps successful responses and rejects Herdr errors', () => {
    expect(parseHerdrJson('{"result":{"ok":true}}')).toEqual({ ok: true });
    expect(() => parseHerdrJson('{"error":{"message":"nope"}}')).toThrow('nope');
  });

  it('discovers every pane with stable identity, mode, and lifecycle', async () => {
    const mappingPath = join(mkdtempSync(join(tmpdir(), 'codeman-herdr-')), 'mappings.json');
    const shellPane = {
      terminal_id: 'term_shell',
      pane_id: 'w2:p1',
      workspace_id: 'w2',
      foreground_cwd: '/workspaces/shell-project',
    };
    const manager = new HerdrMuxManager({
      mappingPath,
      asyncRunner: vi.fn(async () => ({ panes: [codexAgent, shellPane], agents: [], workspaces: [] })),
      syncRunner: vi.fn(() => ({ running: true, compatible: true })),
    });

    const result = await manager.reconcileSessions();
    const sessions = manager.getSessions();
    expect(result.discovered).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      muxName: 'term_123',
      mode: 'codex',
      runtimeAgentKind: 'codex',
      terminalId: 'term_123',
      paneId: 'w1:t1:p1',
      workspaceId: 'w1',
      providerSessionId: 'conversation-123',
      runtimeBackend: 'herdr',
      runtimeStatus: 'busy',
      runtimeWorking: true,
    });
    expect(sessions[1]).toMatchObject({
      muxName: 'term_shell',
      mode: 'shell',
      runtimeAgentKind: undefined,
      name: 'shell-project w2:p1',
    });
  });

  it.each([false, true])('creates a Herdr pane with a readable unique name (collision: %s)', async (collision) => {
    const mappingPath = join(mkdtempSync(join(tmpdir(), 'codeman-herdr-')), 'mappings.json');
    const calls: string[][] = [];
    const manager = new HerdrMuxManager({
      mappingPath,
      asyncRunner: vi.fn(async (args) => {
        if (args[0] === 'workspace' && args[1] === 'list')
          return {
            workspaces: [
              { workspace_id: 'w1', label: 'project' },
              { workspace_id: 'w7', label: 'w1-knowledge-base' },
            ],
          };
        if (args[0] === 'agent' && args[1] === 'list') {
          return { agents: collision ? [{ terminal_id: 'other', name: 'project-mobile-session' }] : [] };
        }
        calls.push(args);
        if (args[0] === 'pane' && args[1] === 'list') return { panes: [] };
        if (args[0] === 'workspace' && args[1] === 'create') {
          return { workspace: { workspace_id: 'w1' }, root_pane: { pane_id: 'w1:t1:p1' } };
        }
        if (args[0] === 'agent' && args[1] === 'start') return { agent: codexAgent };
        throw new Error(`unexpected call: ${args.join(' ')}`);
      }),
      syncRunner: vi.fn(() => ({ running: true, compatible: true })),
    });

    const created = await manager.createSession({
      sessionId: 'session-123',
      workingDir: '/workspaces/project',
      mode: 'codex',
      name: 'Mobile session',
      codexConfig: { model: 'gpt-5', animations: false },
    });

    expect(created.sessionId).toBe('session-123');
    expect(calls).toContainEqual([
      'agent',
      'start',
      collision
        ? `project-mobile-session-${createHash('sha256').update('session-123').digest('hex').slice(0, 8)}`
        : 'project-mobile-session',
      '--kind',
      'codex',
      '--pane',
      'w1:t1:p1',
      '--timeout',
      '45000',
      '--',
      '--config',
      'tui.animations=false',
      '--model',
      'gpt-5',
    ]);
    expect(manager.getAttachArgs(created.muxName)).toEqual(['terminal', 'attach', 'term_123']);
    expect(manager.getAttachArgs(created.muxName, { takeover: true })).toEqual([
      'terminal',
      'attach',
      'term_123',
      '--takeover',
    ]);
  });

  it('keeps the requested session ID when discovery races agent startup', async () => {
    const mappingPath = join(mkdtempSync(join(tmpdir(), 'codeman-herdr-')), 'mappings.json');
    let manager: HerdrMuxManager;
    let paneListCalls = 0;
    manager = new HerdrMuxManager({
      mappingPath,
      asyncRunner: vi.fn(async (args) => {
        if (args[0] === 'workspace' && args[1] === 'list')
          return {
            workspaces: [
              { workspace_id: 'w1', label: 'project' },
              { workspace_id: 'w7', label: 'w1-knowledge-base' },
            ],
          };
        if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
        if (args[0] === 'pane' && args[1] === 'list') {
          paneListCalls += 1;
          return { panes: paneListCalls === 1 ? [] : [codexAgent] };
        }
        if (args[0] === 'workspace' && args[1] === 'create') {
          return { workspace: { workspace_id: 'w1' }, root_pane: { pane_id: 'w1:t1:p1' } };
        }
        if (args[0] === 'agent' && args[1] === 'start') {
          await manager.reconcileSessions();
          return { agent: codexAgent };
        }
        throw new Error(`unexpected call: ${args.join(' ')}`);
      }),
      syncRunner: vi.fn(() => ({ running: true, compatible: true })),
    });

    const created = await manager.createSession({
      sessionId: 'session-race',
      workingDir: '/workspaces/project',
      mode: 'codex',
    });

    expect(created.sessionId).toBe('session-race');
    expect(manager.getSessions().map((session) => session.sessionId)).toEqual(['session-race']);
  });

  it('reads the current Herdr pane geometry for the first attachment', async () => {
    const mappingPath = join(mkdtempSync(join(tmpdir(), 'codeman-herdr-')), 'mappings.json');
    const manager = new HerdrMuxManager({
      mappingPath,
      asyncRunner: vi.fn(async () => ({ panes: [codexAgent], agents: [], workspaces: [] })),
      syncRunner: vi.fn((args) => {
        if (args[0] === 'pane' && args[1] === 'layout') {
          return {
            layout: {
              area: { width: 180, height: 52 },
              panes: [{ pane_id: 'w1:t1:p1', rect: { width: 176, height: 48 } }],
            },
          };
        }
        return { running: true, compatible: true };
      }),
    });

    await manager.reconcileSessions();
    expect(manager.getWindowSize('term_123')).toEqual({ cols: 176, rows: 48 });
  });

  it('creates a tab in the workspace that already owns the requested cwd', async () => {
    const mappingPath = join(mkdtempSync(join(tmpdir(), 'codeman-herdr-')), 'mappings.json');
    const calls: string[][] = [];
    const manager = new HerdrMuxManager({
      mappingPath,
      asyncRunner: vi.fn(async (args) => {
        if (args[0] === 'workspace' && args[1] === 'list')
          return {
            workspaces: [
              { workspace_id: 'w1', label: 'project' },
              { workspace_id: 'w7', label: 'w1-knowledge-base' },
            ],
          };
        if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
        calls.push(args);
        if (args[0] === 'pane' && args[1] === 'list') {
          return {
            panes: [{ pane_id: 'w7:t1:p1', workspace_id: 'w7', cwd: '/workspaces/project' }],
          };
        }
        if (args[0] === 'tab' && args[1] === 'create') {
          return { tab: { tab_id: 'w7:t2' }, root_pane: { pane_id: 'w7:t2:p1' } };
        }
        if (args[0] === 'agent' && args[1] === 'start') {
          return {
            agent: {
              ...codexAgent,
              terminal_id: 'term_456',
              pane_id: 'w7:t2:p1',
              workspace_id: 'w7',
            },
          };
        }
        throw new Error(`unexpected call: ${args.join(' ')}`);
      }),
      syncRunner: vi.fn(() => ({ running: true, compatible: true })),
    });

    const created = await manager.createSession({
      sessionId: 'session-456',
      workingDir: '/workspaces/project',
      mode: 'codex',
      name: 'Second agent',
    });

    expect(created.name).toBe('kb-second-agent');

    expect(calls).toContainEqual([
      'tab',
      'create',
      '--workspace',
      'w7',
      '--cwd',
      '/workspaces/project',
      '--label',
      'Second agent',
      '--no-focus',
    ]);
    expect(calls.some((args) => args[0] === 'workspace' && args[1] === 'create')).toBe(false);
  });

  it('publishes every successful roster and updates a pane in place', async () => {
    const mappingPath = join(mkdtempSync(join(tmpdir(), 'codeman-herdr-')), 'mappings.json');
    let panes = [codexAgent];
    const manager = new HerdrMuxManager({
      mappingPath,
      asyncRunner: vi.fn(async () => ({ panes, agents: [], workspaces: [] })),
      syncRunner: vi.fn(() => ({ running: true, compatible: true })),
    });
    const rosters: unknown[][] = [];
    const updates: unknown[] = [];
    manager.on('rosterUpdated', (roster) => rosters.push(roster));
    manager.on('sessionUpdated', (session) => updates.push(session));

    await manager.reconcileSessions();
    panes = [{ ...codexAgent, agent: undefined, agent_status: 'unknown', foreground_cwd: '/workspaces/new-cwd' }];
    await manager.reconcileSessions();

    expect(rosters).toHaveLength(2);
    expect(updates).toHaveLength(1);
    expect(manager.getSessions()[0]).toMatchObject({
      mode: 'shell',
      workingDir: '/workspaces/new-cwd',
      terminalId: 'term_123',
    });
  });

  it('uses pane input commands for plain shell panes', async () => {
    const mappingPath = join(mkdtempSync(join(tmpdir(), 'codeman-herdr-')), 'mappings.json');
    const calls: string[][] = [];
    const manager = new HerdrMuxManager({
      mappingPath,
      asyncRunner: vi.fn(async (args) => {
        if (args[0] === 'workspace' && args[1] === 'list')
          return {
            workspaces: [
              { workspace_id: 'w1', label: 'project' },
              { workspace_id: 'w7', label: 'w1-knowledge-base' },
            ],
          };
        if (args[0] === 'agent' && args[1] === 'list') return { agents: [] };
        calls.push(args);
        if (args[0] === 'pane' && args[1] === 'list') {
          return { panes: [{ terminal_id: 'term_shell', pane_id: 'w1:p1', cwd: '/workspaces' }] };
        }
        return {};
      }),
      syncRunner: vi.fn(() => ({ running: true, compatible: true })),
    });

    await manager.reconcileSessions();
    const [session] = manager.getSessions();
    await manager.sendInput(session.sessionId, 'echo safe\r');

    expect(calls).toContainEqual(['pane', 'send-text', 'w1:p1', 'echo safe']);
    expect(calls).toContainEqual(['pane', 'send-keys', 'w1:p1', 'enter']);
  });
});

describe('Herdr shell tab labels', () => {
  it('tracks tab renames and removal, keeps cached labels on lookup failure, and preserves manual names', async () => {
    let label = 'First label';
    let unavailable = false;
    const pane = {
      terminal_id: 'term_shell',
      pane_id: 'w1:p3',
      tab_id: 'w1:t3',
      workspace_id: 'w1',
      cwd: '/workspaces/knowledge-base',
    };
    const manager = new HerdrMuxManager({
      mappingPath: join(mkdtempSync(join(tmpdir(), 'herdr-tab-labels-')), 'mappings.json'),
      asyncRunner: async (args) => {
        if (args[0] === 'pane') return { panes: [pane] };
        if (args[0] === 'agent') return { agents: [] };
        if (args[0] === 'workspace') return { workspaces: [{ workspace_id: 'w1', label: 'knowledge-base' }] };
        if (args.join(' ') === 'tab list --workspace w1') {
          if (unavailable) throw new Error('Tab lookup unavailable');
          return { tabs: [{ tab_id: 'w1:t3', number: 3, label }] };
        }
        throw new Error('Unexpected Herdr call');
      },
      syncRunner: () => ({}),
    });
    const observed: string[] = [];
    manager.on('sessionUpdated', (session) => observed.push(session.name));
    await manager.reconcileSessions();
    const id = manager.getSessions()[0].sessionId;
    expect(manager.getSessions()[0].name).toBe('First label');
    label = 'Renamed label';
    await manager.reconcileSessions();
    expect(manager.getSessions()[0].name).toBe('Renamed label');
    manager.updateSessionName(id, 'stale saved display');
    expect(manager.getSessions()[0].name).toBe('Renamed label');
    expect(observed).toContain('Renamed label');
    unavailable = true;
    await manager.reconcileSessions();
    expect(manager.getSessions()[0].name).toBe('Renamed label');
    unavailable = false;
    label = '3';
    await manager.reconcileSessions();
    expect(manager.getSessions()[0].name).toBe('knowledge-base w1:p3');
    manager.updateSessionName(id, 'Manual name', 'manual');
    const manual = manager.getSessions()[0].name;
    label = 'Another tab label';
    await manager.reconcileSessions();
    expect(manager.getSessions()[0].name).toBe(manual);
  });
});

describe('bidirectional manual labels', () => {
  it('keeps the same ID and newest pane label across both rename directions and restoration', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'herdr-shared-label-')), 'mapping.json');
    const pane = { terminal_id: 'term_manual', pane_id: 'w1:p4', workspace_id: 'w1', cwd: '/workspaces', label: '' };
    const options = {
      mappingPath: path,
      asyncRunner: async (args: string[]) => {
        if (args[0] === 'pane') return { panes: [{ ...pane }] };
        if (args[0] === 'agent') return { agents: [] };
        return { workspaces: [{ workspace_id: 'w1', label: 'workspaces' }] };
      },
      syncRunner: (args: string[]) => {
        if (args[0] === 'pane' && args[1] === 'rename') pane.label = args[3];
        return {};
      },
    };
    const manager = new HerdrMuxManager(options);
    await manager.reconcileSessions();
    const id = manager.getSessions()[0].sessionId;
    pane.label = 'Herdr first';
    await manager.reconcileSessions();
    expect(manager.getSessions()[0].name).toBe('Herdr first');
    manager.updateSessionName(id, 'Codeman second', 'manual');
    await manager.reconcileSessions();
    expect(pane.label).toBe('Codeman second');
    expect(manager.getSessions()[0].name).toBe('Codeman second');
    pane.label = 'Herdr third';
    await manager.reconcileSessions();
    expect(manager.getSessions()[0].name).toBe('Herdr third');
    const restored = new HerdrMuxManager(options);
    await restored.reconcileSessions();
    restored.updateSessionName(id, 'stale saved label');
    expect(restored.getSessions()[0]).toMatchObject({ sessionId: id, name: 'Herdr third' });
  });

  it('adopts external agent names without automatically renaming them back', async () => {
    const fixture = namingFixture();
    await fixture.manager.reconcileSessions();
    fixture.agents[0].name = 'external-manual-name';
    await fixture.manager.reconcileSessions();
    await fixture.manager.reconcileSessions();
    expect(fixture.manager.getSessions()[0].name).toBe('external-manual-name');
  });
});
