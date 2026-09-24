/**
 * @fileoverview Herdr-backed implementation of Codeman's terminal multiplexer.
 *
 * Herdr remains the sole owner of pane PTYs. Codeman discovers every pane and
 * opens a short-lived direct terminal attachment only while a browser is using
 * a session.
 */

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { promisify } from 'node:util';
import { dataPath } from './config/instance.js';
import { getCli } from './config/cli-registry/index.js';
import type { CliCapabilities, CliEntry } from './config/cli-registry/types.js';
import { buildEffortCliArgs } from './session-cli-builder.js';
import type {
  CreateSessionOptions,
  MuxSession,
  MuxSessionWithStats,
  PaneCaptureOptions,
  RespawnPaneOptions,
  TerminalMultiplexer,
} from './mux-interface.js';
import type { ProcessStats, SessionMode } from './types.js';

const execFileAsync = promisify(execFile);
const DEFAULT_POLL_MS = 2000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

type JsonRecord = Record<string, unknown>;
type AsyncRunner = (args: string[]) => Promise<unknown>;
type SyncRunner = (args: string[]) => unknown;

interface WorkspaceOrigin {
  originWorkspaceId?: string;
  originWorkspaceLabel?: string;
  originWorkspaceAlias?: string;
}

interface PersistedHerdrMapping extends WorkspaceOrigin {
  sessionId: string;
  terminalId: string;
  createdAt: number;
  name?: string;
  agentName?: string;
  agentNameTitle?: string;
  nameSource?: 'auto' | 'manual';
  manualName?: string;
  nameVersion?: number;
  observedPaneLabel?: string;
  observedAgentName?: string;
  pendingPaneLabel?: string;
  projectAlias?: string;
  agentNameAlias?: string;
  lastReportedTitle?: string;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function parseHerdrJson(value: string | unknown): unknown {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  const body = record(parsed);
  if (body.error) {
    const error = record(body.error);
    throw new Error(stringValue(error.message) || stringValue(body.error) || 'Herdr request failed');
  }
  return body.result ?? parsed;
}

function agentKind(agent: JsonRecord): string {
  return stringValue(agent.agent) || stringValue(record(agent.agent).kind) || stringValue(agent.kind) || '';
}

function sessionMode(kind: string): SessionMode {
  const entry = getCli(kind.toLowerCase());
  return entry?.enabled ? (entry.id as SessionMode) : 'shell';
}

function isShellMode(mode: SessionMode): boolean {
  return getCli(mode)?.kind === 'shell';
}

function codexNativeArgs(options: CreateSessionOptions): string[] {
  const args: string[] = [];
  if (options.codexConfig?.dangerouslyBypassApprovals) args.push('--dangerously-bypass-approvals-and-sandbox');
  if (options.codexConfig?.animations !== undefined) {
    args.push('--config', `tui.animations=${options.codexConfig.animations ? 'true' : 'false'}`);
  }
  if (options.codexConfig?.model) args.push('--model', options.codexConfig.model);
  if (options.codexConfig?.resumeSessionId) args.push('resume', options.codexConfig.resumeSessionId);
  return args;
}

// Mirrors the registry's claude `new`/`resume` launch variants. Herdr passes these
// as argv, so values need no shell quoting. `--session-id` pins the conversation
// to the Codeman session id, which is what the claude-jsonl transcript reader keys on.
function claudeNativeArgs(options: CreateSessionOptions): string[] {
  const args: string[] = [];
  const mode = options.claudeMode || 'dangerously-skip-permissions';
  if (mode === 'dangerously-skip-permissions') args.push('--dangerously-skip-permissions');
  else if (mode === 'auto') args.push('--permission-mode', 'auto');
  else if (mode === 'allowedTools' && options.allowedTools) args.push('--allowedTools', options.allowedTools);
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
  else args.push('--session-id', options.sessionId);
  if (options.model) args.push('--model', options.model);
  args.push(...buildEffortCliArgs(options.effort));
  return args;
}

// Herdr starts an agent by its own kind name. The CLI is matched by its transcript
// capability (registry data), which is also what Codeman reads the conversation from.
const HERDR_AGENT_LAUNCHERS: Partial<
  Record<CliCapabilities['transcript'], { kind: string; args: (options: CreateSessionOptions) => string[] }>
> = {
  'codex-rollout': { kind: 'codex', args: codexNativeArgs },
  'claude-jsonl': { kind: 'claude', args: claudeNativeArgs },
};

// `herdr agent start` reports a detected agent sitting on a startup prompt as
// agent_not_ready "blocked during startup"; every other failure keeps failing.
function isBlockedAtStartup(error: unknown): boolean {
  const detail = `${(error as { stderr?: unknown })?.stderr ?? ''}${error instanceof Error ? error.message : String(error)}`;
  return detail.includes('agent_not_ready') && detail.includes('blocked during startup');
}

function herdrAgentLauncher(cli: CliEntry | undefined) {
  return cli ? HERDR_AGENT_LAUNCHERS[cli.capabilities.transcript] : undefined;
}

function defaultPaneName(pane: JsonRecord, paneId: string, mode: SessionMode, tabLabel?: string): string {
  const explicit = stringValue(pane.label) || stringValue(pane.title) || stringValue(pane.terminal_title_stripped);
  if (explicit) return explicit;
  const cli = getCli(mode);
  const shell = cli?.kind === 'shell';
  if (shell && tabLabel) return tabLabel;
  const cwd = stringValue(pane.foreground_cwd) || stringValue(pane.cwd);
  if (!shell) return `${cli?.label || mode} ${paneId}`;
  return `${cwd ? basename(cwd) : 'Shell'} ${paneId}`;
}

function agentState(agent: JsonRecord): string {
  const raw = agent.agent_status;
  return (
    stringValue(raw) ||
    stringValue(record(raw).state) ||
    stringValue(record(raw).status) ||
    'unknown'
  ).toLowerCase();
}

function providerSessionId(agent: JsonRecord): string | undefined {
  const raw = agent.agent_session;
  return stringValue(raw) || stringValue(record(raw).value) || stringValue(record(raw).id);
}

function lifecycleStatus(state: string): Pick<MuxSession, 'runtimeStatus' | 'runtimeWorking'> {
  if (state === 'working') return { runtimeStatus: 'busy', runtimeWorking: true };
  if (state === 'blocked') return { runtimeStatus: 'busy', runtimeWorking: false };
  if (state === 'done' || state === 'idle') return { runtimeStatus: 'idle', runtimeWorking: false };
  return { runtimeStatus: 'idle', runtimeWorking: false };
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  const body = record(value);
  return (
    stringValue(body.text) || stringValue(body.output) || stringValue(body.content) || stringValue(body.screen) || ''
  );
}

function stableDiscoveredId(terminalId: string): string {
  return `herdr-${createHash('sha256').update(terminalId).digest('hex').slice(0, 32)}`;
}

const NAME_VERSION = 4;
const WORKSPACE_ALIASES: Record<string, string> = {
  workspaces: 'ws',
  'cancilico-devbox': 'db',
  'knowledge-base': 'kb',
  cvision_v01: 'cv01',
  cvision_v02: 'cv02',
  cvision_superrepo_v01: 'cv01',
  cvision_superrepo_v02: 'cv02',
  'annotation-platform': 'ap',
};

export function workspaceAlias(label: string): string {
  const normalized = label
    .toLowerCase()
    .replace(/^w[0-9a-z]+-/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  const alias = WORKSPACE_ALIASES[normalized] || normalized || 'ws';
  return (/^[a-z]/.test(alias) ? alias : `w-${alias}`).slice(0, 8).replace(/[-_]+$/, '');
}

export function projectAlias(cwd: string, workspaceLabel?: string): string | undefined {
  // Prefer the nearest recognized project, including nested monorepo directories.
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean).reverse();
  for (const part of parts) {
    const alias = WORKSPACE_ALIASES[part.toLowerCase()];
    if (alias && part.toLowerCase() !== 'workspaces') return alias;
  }
  return workspaceLabel ? workspaceAlias(workspaceLabel) : undefined;
}

function conversationTitle(agent: JsonRecord, mapping: PersistedHerdrMapping): string | undefined {
  const raw = stringValue(agent.title) || stringValue(agent.terminal_title_stripped);
  if (!raw) return undefined;
  const title = raw.replace(/\s+\|\s+[^|]+$/, '').trim();
  const cwd = stringValue(agent.foreground_cwd) || stringValue(agent.cwd) || '';
  if (
    !title ||
    title === mapping.agentName ||
    title === mapping.name ||
    title === stringValue(agent.name) ||
    title === cwd ||
    title === basename(cwd) ||
    /\bw[0-9a-z]+:(?:t[0-9a-z]+:)?p[0-9a-z]+\b/i.test(title) ||
    /^(?:codex|shell|agent|terminal|new (?:session|tab)|w[0-9a-z]+-.+)$/i.test(title)
  )
    return undefined;
  return title;
}
const FILLER_WORDS = new Set(
  (
    'a an the please kindly to of for in on at from into with ' +
    'i me my mine we us our ours you your yours he him his she her hers they them their theirs ' +
    'it its this that these those be am is are was were been being can could would should will'
  ).split(' ')
);

function fitName(parts: string[], limit = 32): string {
  const kept: string[] = [];
  for (const part of parts) {
    if ([...kept, part].join('-').length > limit) break;
    kept.push(part);
  }
  return (kept.length ? kept.join('-') : parts[0].slice(0, limit)).replace(/[-_]+$/, '');
}

export function normalizeAgentName(title: string, automatic = true): string {
  const lower = title.toLowerCase();
  const original = lower.match(/[a-z0-9_]+(?:['’.-][a-z0-9_]+)*/g) || [];
  const trimmed = lower.replace(
    /^(?:(?:would be nice (?:if|of)|(?:can|could|would|will) you|i (?:would like|want) to|help me)[\s,!:;.-]+)+/,
    ''
  );
  let words = automatic
    ? (trimmed.match(/[a-z0-9_]+(?:['’.-][a-z0-9_]+)*/g) || []).filter((word) => !FILLER_WORDS.has(word)).slice(0, 4)
    : original;
  if (!words.length) words = original;
  const parts = words
    .map((word) =>
      word
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^[-_]+|[-_]+$/g, '')
    )
    .filter(Boolean);
  if (!parts.length) parts.push('agent');
  if (!/^[a-z]/.test(parts[0])) parts[0] = `agent-${parts[0]}`;
  return fitName(parts);
}

function sessionChanged(before: MuxSession, after: MuxSession): boolean {
  return (
    before.muxName !== after.muxName ||
    before.mode !== after.mode ||
    before.paneId !== after.paneId ||
    before.workspaceId !== after.workspaceId ||
    before.workingDir !== after.workingDir ||
    before.name !== after.name ||
    before.runtimeStatus !== after.runtimeStatus ||
    before.runtimeWorking !== after.runtimeWorking ||
    before.runtimeAgentKind !== after.runtimeAgentKind ||
    before.providerSessionId !== after.providerSessionId
  );
}

export class HerdrMuxManager extends EventEmitter implements TerminalMultiplexer {
  readonly backend = 'herdr' as const;
  readonly autoAttachOnRestore = false;
  readonly muxSocket = 'herdr';

  private readonly bin: string;
  private readonly mappingPath: string;
  private readonly asyncRunner: AsyncRunner;
  private readonly syncRunner: SyncRunner;
  private readonly hasCustomSyncRunner: boolean;
  private readonly sessions = new Map<string, MuxSession>();
  private readonly mappingsByTerminal = new Map<string, PersistedHerdrMapping>();
  private readonly pendingCreatesByPane = new Map<string, string>();
  private readonly pendingAgentNames = new Map<string, string>();
  private agentTitleResolver?: () => Promise<Map<string, string>>;
  private reconciliation: Promise<{ alive: string[]; dead: string[]; discovered: string[] }> | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private readonly tabLabelsByWorkspace = new Map<string, Map<string, string>>();

  constructor({
    bin = process.env.HERDR_BIN || 'herdr',
    mappingPath = dataPath('herdr-mux-sessions.json'),
    asyncRunner,
    syncRunner,
  }: {
    bin?: string;
    mappingPath?: string;
    asyncRunner?: AsyncRunner;
    syncRunner?: SyncRunner;
  } = {}) {
    super();
    this.bin = bin;
    this.mappingPath = mappingPath;
    this.hasCustomSyncRunner = syncRunner !== undefined;
    this.asyncRunner =
      asyncRunner ||
      (async (args) => {
        const { stdout } = await execFileAsync(this.bin, args, {
          encoding: 'utf8',
          timeout: 45_000,
          maxBuffer: 8 * 1024 * 1024,
          env: process.env,
        });
        return parseHerdrJson(stdout);
      });
    this.syncRunner =
      syncRunner ||
      ((args) =>
        parseHerdrJson(
          execFileSync(this.bin, args, {
            encoding: 'utf8',
            timeout: 10_000,
            maxBuffer: 8 * 1024 * 1024,
            env: process.env,
          })
        ));
    this.loadMappings();
  }

  private loadMappings(): void {
    if (!existsSync(this.mappingPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.mappingPath, 'utf8')) as { mappings?: PersistedHerdrMapping[] };
      for (const item of parsed.mappings || []) {
        if (item?.sessionId && item?.terminalId) this.mappingsByTerminal.set(item.terminalId, item);
      }
    } catch (error) {
      console.warn('[HerdrMuxManager] Ignoring invalid mapping file:', error);
    }
  }

  private saveMappings(): void {
    mkdirSync(dirname(this.mappingPath), { recursive: true });
    const temporary = `${this.mappingPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ mappings: [...this.mappingsByTerminal.values()] }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporary, this.mappingPath);
  }

  private async run(args: string[]): Promise<unknown> {
    return parseHerdrJson(await this.asyncRunner(args));
  }

  private runSync(args: string[]): unknown {
    return parseHerdrJson(this.syncRunner(args));
  }

  private runTextSync(args: string[]): string {
    if (this.hasCustomSyncRunner) {
      const value = this.syncRunner(args);
      return typeof value === 'string' ? value : outputText(parseHerdrJson(value));
    }
    return execFileSync(this.bin, args, {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    });
  }

  private mappingFor(terminalId: string, preferredSessionId?: string, createdAt = Date.now()): PersistedHerdrMapping {
    const existing = this.mappingsByTerminal.get(terminalId);
    if (existing) {
      // A reconciliation poll can observe a newly started agent before
      // createSession() receives the start response. Replace only the generated
      // discovery alias with the caller's requested stable Codeman ID.
      if (
        preferredSessionId &&
        existing.sessionId !== preferredSessionId &&
        existing.sessionId === stableDiscoveredId(terminalId)
      ) {
        this.sessions.delete(existing.sessionId);
        existing.sessionId = preferredSessionId;
        this.saveMappings();
      }
      return existing;
    }
    const mapping = {
      sessionId: preferredSessionId || stableDiscoveredId(terminalId),
      terminalId,
      createdAt,
    };
    this.mappingsByTerminal.set(terminalId, mapping);
    this.saveMappings();
    return mapping;
  }

  private sessionFromPane(
    rawValue: unknown,
    preferredSessionId?: string,
    workspaces = new Map<string, string>(),
    tabLabels = new Map<string, string>()
  ): MuxSession | null {
    const pane = record(rawValue);
    const terminalId = stringValue(pane.terminal_id) || stringValue(record(pane.terminal).terminal_id);
    const paneId = stringValue(pane.pane_id);
    if (!terminalId || !paneId) return null;
    const reportedCreatedAt = numberValue(pane.created_at) || Date.parse(stringValue(pane.created_at) || '');
    const mapping = this.mappingFor(
      terminalId,
      preferredSessionId || this.pendingCreatesByPane.get(paneId),
      Number.isFinite(reportedCreatedAt) ? reportedCreatedAt : Date.now()
    );
    if (this.captureWorkspaceOrigin(mapping, stringValue(pane.workspace_id), workspaces)) this.saveMappings();
    const currentAlias = projectAlias(
      stringValue(pane.foreground_cwd) || stringValue(pane.cwd) || '',
      workspaces.get(stringValue(pane.workspace_id) || '')
    );
    if (currentAlias && currentAlias !== mapping.projectAlias) {
      mapping.projectAlias = currentAlias;
      this.saveMappings();
    }
    const kind = agentKind(pane).toLowerCase();
    const mode = sessionMode(kind);
    const state = agentState(pane);
    const label = stringValue(pane.label) || '';
    if (label === mapping.pendingPaneLabel) mapping.pendingPaneLabel = undefined;
    // Only explicit pane labels are shared names; OSC titles and tab labels
    // remain automatic context. A stale poll of the pre-rename label is ignored.
    if (label !== mapping.observedPaneLabel && label !== mapping.pendingPaneLabel) {
      if (label) {
        mapping.name = isShellMode(mode) ? label : normalizeAgentName(label, false);
        mapping.manualName = mapping.name;
        mapping.nameSource = 'manual';
        mapping.nameVersion = NAME_VERSION;
        mapping.pendingPaneLabel = undefined;
      } else if (mapping.observedPaneLabel) {
        mapping.nameSource = 'auto';
        mapping.manualName = undefined;
        mapping.name = undefined;
      }
    }
    if (mapping.observedPaneLabel !== label) {
      mapping.observedPaneLabel = label;
      this.saveMappings();
    }
    const fallback = defaultPaneName(pane, paneId, mode, tabLabels.get(stringValue(pane.tab_id) || ''));
    const shellOwned = isShellMode(mode) && mapping.nameSource !== 'manual';
    const name = shellOwned ? fallback : mapping.name || fallback;
    // Saved Codeman display state is not authoritative over current Herdr tab
    // labels. Mark this mapping current so startup restoration cannot revert it.
    if (shellOwned && (mapping.name !== name || mapping.nameVersion !== NAME_VERSION)) {
      mapping.name = name;
      mapping.nameSource = 'auto';
      mapping.nameVersion = NAME_VERSION;
      this.saveMappings();
    }
    return {
      sessionId: mapping.sessionId,
      muxName: terminalId,
      pid: numberValue(pane.foreground_pid) || numberValue(pane.pid) || 0,
      createdAt: mapping.createdAt,
      workingDir: stringValue(pane.foreground_cwd) || stringValue(pane.cwd) || process.cwd(),
      mode,
      attached: false,
      name,
      runtimeBackend: 'herdr',
      runtimeAgentKind: kind || undefined,
      terminalId,
      paneId,
      workspaceId: stringValue(pane.workspace_id),
      providerSessionId: providerSessionId(pane),
      ...lifecycleStatus(state),
    };
  }

  private async panes(): Promise<unknown[]> {
    const response = record(await this.run(['pane', 'list']));
    return arrayValue(response.panes ?? record(response.pane_list).panes);
  }

  private async shellTabLabels(panes: unknown[]): Promise<Map<string, string>> {
    // Pane listings do not contain Herdr tab labels. Fetch each relevant
    // workspace once; keep the last successful labels during transient errors.
    const workspaceIds = new Set<string>();
    for (const raw of panes) {
      const pane = record(raw);
      const workspaceId = stringValue(pane.workspace_id);
      if (workspaceId && stringValue(pane.tab_id) && sessionMode(agentKind(pane)) === 'shell') {
        workspaceIds.add(workspaceId);
      }
    }
    await Promise.all(
      [...workspaceIds].map(async (workspaceId) => {
        try {
          const response = record(await this.run(['tab', 'list', '--workspace', workspaceId]));
          if (!Array.isArray(response.tabs)) throw new Error('Herdr did not return a tab list');
          const labels = new Map<string, string>();
          for (const raw of response.tabs) {
            const tab = record(raw);
            const id = stringValue(tab.tab_id);
            const label = stringValue(tab.label);
            // Numeric default labels are not user names; retain useful cwd/pane
            // fallbacks for those. Do not rename or write anything back to Herdr.
            if (id && label && label !== String(tab.number)) labels.set(id, label);
          }
          this.tabLabelsByWorkspace.set(workspaceId, labels);
        } catch (error) {
          console.warn('[HerdrMuxManager] Could not read shell tab labels:', error);
        }
      })
    );
    for (const id of this.tabLabelsByWorkspace.keys()) {
      if (!workspaceIds.has(id)) this.tabLabelsByWorkspace.delete(id);
    }
    return new Map([...this.tabLabelsByWorkspace.values()].flatMap((labels) => [...labels]));
  }

  private async agents(): Promise<JsonRecord[]> {
    const response = record(await this.run(['agent', 'list']));
    if (!Array.isArray(response.agents)) throw new Error('Herdr did not return an agent list');
    return response.agents.map(record);
  }

  private async workspaces(): Promise<Map<string, string>> {
    const response = record(await this.run(['workspace', 'list']));
    if (!Array.isArray(response.workspaces)) throw new Error('Herdr did not return a workspace list');
    const labels = new Map<string, string>();
    for (const raw of response.workspaces) {
      const workspace = record(raw);
      const id = stringValue(workspace.workspace_id);
      const label = stringValue(workspace.label);
      if (id && label) labels.set(id, label);
    }
    return labels;
  }

  private captureWorkspaceOrigin(
    origin: WorkspaceOrigin,
    workspaceId: string | undefined,
    labels: Map<string, string>
  ): boolean {
    let changed = false;
    if (!origin.originWorkspaceId && workspaceId) {
      origin.originWorkspaceId = workspaceId;
      changed = true;
    }
    const label = origin.originWorkspaceId && labels.get(origin.originWorkspaceId);
    if (!origin.originWorkspaceAlias && label) {
      origin.originWorkspaceLabel = label;
      origin.originWorkspaceAlias = workspaceAlias(label);
      changed = true;
    }
    return changed;
  }

  private occupiedAgentNames(agents: JsonRecord[]): Map<string, string> {
    const occupied = new Map<string, string>();
    for (const agent of agents) {
      const name = stringValue(agent.name);
      if (name) occupied.set(name, stringValue(agent.terminal_id) || 'unknown');
    }
    return occupied;
  }

  private chooseAgentName(
    title: string,
    sessionId: string,
    terminalId: string | undefined,
    occupied: Map<string, string>,
    mapping?: PersistedHerdrMapping
  ): string {
    const available = (name: string) =>
      (!occupied.has(name) || occupied.get(name) === terminalId) &&
      ![...this.pendingAgentNames].some(([id, pending]) => id !== sessionId && pending === name);
    if (
      mapping?.nameVersion === NAME_VERSION &&
      mapping.agentNameTitle === title &&
      (mapping.nameSource === 'manual' || mapping.agentNameAlias === mapping.projectAlias) &&
      mapping.agentName &&
      available(mapping.agentName)
    ) {
      return mapping.agentName;
    }
    const automatic = mapping?.nameSource !== 'manual';
    const alias = mapping?.projectAlias || mapping?.originWorkspaceAlias;
    const prefix = automatic && alias ? `${alias}-` : '';
    const task = normalizeAgentName(title, automatic);
    const fit = (limit: number) => `${prefix}${fitName(task.split('-'), Math.max(1, limit - prefix.length))}`;
    const base = fit(32);
    if (available(base)) return base;
    const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
    for (let index = 0; ; index += 1) {
      const suffix = `-${hash}${index ? `-${index}` : ''}`;
      const candidate = `${fit(32 - suffix.length)}${suffix}`;
      if (available(candidate)) return candidate;
    }
  }

  setAgentTitleResolver(resolver: () => Promise<Map<string, string>>): void {
    this.agentTitleResolver = resolver;
  }

  private publishName(session: MuxSession, mapping: PersistedHerdrMapping, title: string, name: string): void {
    const changed = session.name !== name;
    const needsSave =
      mapping.name !== name ||
      mapping.agentName !== name ||
      mapping.agentNameTitle !== title ||
      mapping.agentNameAlias !== mapping.projectAlias ||
      mapping.nameVersion !== NAME_VERSION;
    mapping.name = name;
    mapping.agentName = name;
    mapping.agentNameTitle = title;
    mapping.agentNameAlias = mapping.projectAlias;
    mapping.nameSource ??= 'auto';
    mapping.nameVersion = NAME_VERSION;
    session.name = name;
    if (needsSave) this.saveMappings();
    if (changed) this.emit('sessionUpdated', session);
  }

  private async syncAgentNames(agents: JsonRecord[]): Promise<void> {
    let displayNames: Map<string, string>;
    try {
      displayNames = (await this.agentTitleResolver?.()) ?? new Map();
    } catch (error) {
      // Keep existing names on transient resolution failures, rather than
      // oscillating between conversation titles and stored session names.
      console.warn('[HerdrMuxManager] Could not resolve Codeman tab titles:', error);
      return;
    }
    const occupied = this.occupiedAgentNames(agents);
    for (const agent of agents) {
      const terminalId = stringValue(agent.terminal_id);
      const paneId = stringValue(agent.pane_id);
      if (!terminalId || !paneId || this.pendingCreatesByPane.has(paneId)) continue;
      const mapping = this.mappingsByTerminal.get(terminalId);
      const session = mapping && this.sessions.get(mapping.sessionId);
      if (!mapping || !session) continue;
      // The starter owns its temporary name until Herdr finishes the handshake.
      // Do not turn that temporary ownership name into a permanent manual name.
      if (agent.interactive_ready === false) continue;
      const observed = stringValue(agent.name) || '';
      if (
        (mapping.nameVersion ?? 0) >= 3 &&
        mapping.agentName &&
        mapping.observedAgentName !== undefined &&
        observed &&
        observed !== mapping.observedAgentName &&
        observed !== mapping.agentName
      ) {
        mapping.nameSource = 'manual';
        mapping.manualName = observed;
        mapping.agentNameTitle = undefined;
        // Mirror an external agent rename into its explicit pane label too.
        try {
          await this.run(['pane', 'rename', paneId, observed]);
          mapping.pendingPaneLabel = observed;
        } catch (error) {
          console.warn('[HerdrMuxManager] Could not mirror agent label:', error);
          continue;
        }
      }
      mapping.observedAgentName = observed;
      if (mapping.nameSource !== 'manual' && !mapping.projectAlias) continue;
      const reportedTitle = conversationTitle(agent, mapping);
      const changedTitle =
        mapping.lastReportedTitle !== undefined && reportedTitle !== mapping.lastReportedTitle
          ? reportedTitle
          : undefined;
      const savedTitle = conversationTitle(
        { ...agent, title: mapping.agentNameTitle, terminal_title_stripped: '' },
        mapping
      );
      const title =
        mapping.nameSource === 'manual'
          ? mapping.manualName || mapping.name || ''
          : displayNames.get(session.sessionId) || changedTitle || savedTitle || reportedTitle || 'Codex';
      const name = this.chooseAgentName(title, session.sessionId, terminalId, occupied, mapping);
      try {
        if (agent.name !== name) {
          await this.run(['agent', 'rename', paneId, name]);
          const previous = stringValue(agent.name);
          if (previous) occupied.delete(previous);
          occupied.set(name, terminalId);
          mapping.observedAgentName = name;
        }
        // A manual rename can arrive while Herdr is acknowledging this command.
        if (mapping.nameSource !== 'manual' || title === mapping.manualName) {
          if (reportedTitle) mapping.lastReportedTitle = reportedTitle;
          this.publishName(session, mapping, title, name);
        }
      } catch (error) {
        // A pane can exit or move while this snapshot is being reconciled.
        // Leave its title intact and retry against fresh identity next poll.
        console.warn(`[HerdrMuxManager] Could not sync agent name for ${terminalId}:`, error);
      }
    }
  }

  async createSession(options: CreateSessionOptions): Promise<MuxSession> {
    const cli = getCli(options.mode);
    const launcher = herdrAgentLauncher(cli);
    if (!cli || (!launcher && cli.kind !== 'shell')) {
      throw new Error('The Herdr backend supports Codex, Claude and shell sessions');
    }
    const defaultLabel = cli.label || cli.id;
    // Workspace list intentionally omits cwd. Pane list carries both cwd and
    // workspace_id, so it is the authoritative way to reuse an existing
    // workspace for another Codeman tab.
    const paneResponse = record(await this.run(['pane', 'list']));
    const existingPane = arrayValue(paneResponse.panes)
      .map(record)
      .find(
        (item) =>
          stringValue(item.foreground_cwd) === options.workingDir || stringValue(item.cwd) === options.workingDir
      );
    const existingWorkspaceId = existingPane && stringValue(existingPane.workspace_id);
    let workspaceId: string | undefined;
    let paneId: string | undefined;
    let createdWorkspace = false;
    let createdTabId: string | undefined;
    try {
      if (existingWorkspaceId) {
        workspaceId = existingWorkspaceId;
        const tabResult = record(
          await this.run([
            'tab',
            'create',
            '--workspace',
            workspaceId,
            '--cwd',
            options.workingDir,
            '--label',
            options.name || defaultLabel,
            '--no-focus',
          ])
        );
        createdTabId = stringValue(record(tabResult.tab).tab_id) || stringValue(tabResult.tab_id);
        paneId = stringValue(record(tabResult.root_pane).pane_id) || stringValue(tabResult.pane_id);
      } else {
        createdWorkspace = true;
        const created = record(
          await this.run([
            'workspace',
            'create',
            '--cwd',
            options.workingDir,
            '--label',
            basename(options.workingDir) || 'workspaces',
            '--no-focus',
          ])
        );
        workspaceId = stringValue(record(created.workspace).workspace_id) || stringValue(created.workspace_id);
        paneId = stringValue(record(created.root_pane).pane_id) || stringValue(created.pane_id);
      }
      if (!workspaceId || !paneId) throw new Error('Herdr did not return a workspace and root pane');
      this.pendingCreatesByPane.set(paneId, options.sessionId);

      const origin: PersistedHerdrMapping = { sessionId: options.sessionId, terminalId: '', createdAt: Date.now() };
      const workspaceLabels = await this.workspaces().catch((error) => {
        console.warn('[HerdrMuxManager] Could not read workspace names:', error);
        return new Map<string, string>();
      });
      this.captureWorkspaceOrigin(origin, workspaceId, workspaceLabels);
      origin.projectAlias = projectAlias(options.workingDir, workspaceLabels.get(workspaceId));

      if (!launcher) {
        // A shell session is the tab's root pane itself; its name follows the
        // Herdr tab label, so no agent start or agent rename is involved.
        const match = (await this.panes()).find((candidate) => stringValue(record(candidate).pane_id) === paneId);
        const session = this.sessionFromPane(match, options.sessionId, workspaceLabels);
        if (!session) throw new Error('Herdr created a shell pane but did not expose its terminal identity');
        this.sessions.set(session.sessionId, session);
        this.emit('sessionCreated', session);
        return session;
      }

      const nativeArgs = launcher.args(options);
      const agentName = this.chooseAgentName(
        options.name || defaultLabel,
        options.sessionId,
        undefined,
        this.occupiedAgentNames(await this.agents()),
        origin
      );
      this.pendingAgentNames.set(options.sessionId, agentName);
      const startArgs = ['agent', 'start', agentName, '--kind', launcher.kind, '--pane', paneId, '--timeout', '45000'];
      if (nativeArgs.length) startArgs.push('--', ...nativeArgs);
      let started: Record<string, unknown> = {};
      try {
        started = record(await this.run(startArgs));
      } catch (error) {
        // Herdr refuses to call an agent ready while it is blocked on a startup
        // prompt (Claude's workspace-trust dialog in a new directory). The agent
        // is running and waiting for input, so keep its pane: the session's own
        // trust-dialog handling or the user answers it.
        if (!isBlockedAtStartup(error)) throw error;
      }
      const rawAgent = record(started.agent);
      let session = this.sessionFromPane({ ...rawAgent, pane_id: rawAgent.pane_id || paneId }, options.sessionId);
      if (!session) {
        const match = (await this.panes()).find((candidate) => stringValue(record(candidate).pane_id) === paneId);
        session = this.sessionFromPane(match, options.sessionId);
      }
      if (!session) throw new Error(`Herdr started ${defaultLabel} but did not expose its terminal identity`);
      session.name = agentName;
      const mapping = this.mappingsByTerminal.get(session.terminalId!);
      if (mapping) {
        this.captureWorkspaceOrigin(mapping, workspaceId, workspaceLabels);
        mapping.projectAlias = origin.projectAlias;
        mapping.agentNameAlias = origin.projectAlias;
        mapping.name = agentName;
        mapping.agentName = agentName;
        mapping.agentNameTitle = options.name || defaultLabel;
        mapping.nameSource = 'auto';
        mapping.nameVersion = mapping.originWorkspaceAlias ? NAME_VERSION : undefined;
        this.saveMappings();
      }
      this.sessions.set(session.sessionId, session);
      this.emit('sessionCreated', session);
      return session;
    } catch (error) {
      if (createdWorkspace && workspaceId) await this.run(['workspace', 'close', workspaceId]).catch(() => undefined);
      else if (createdTabId) await this.run(['tab', 'close', createdTabId]).catch(() => undefined);
      throw error;
    } finally {
      this.pendingAgentNames.delete(options.sessionId);
      if (paneId) this.pendingCreatesByPane.delete(paneId);
    }
  }

  async killSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session?.paneId) return false;
    await this.run(['pane', 'close', session.paneId]);
    this.sessions.delete(sessionId);
    this.emit('sessionKilled', { sessionId });
    return true;
  }

  destroy(): void {
    this.stopStatsCollection();
    this.removeAllListeners();
  }

  getSessions(): MuxSession[] {
    return [...this.sessions.values()];
  }

  getSession(sessionId: string): MuxSession | undefined {
    return this.sessions.get(sessionId);
  }

  async getSessionsWithStats(): Promise<MuxSessionWithStats[]> {
    return Promise.all(
      this.getSessions().map(async (session) => ({
        ...session,
        stats: (await this.getProcessStats(session.sessionId)) || undefined,
      }))
    );
  }

  async getProcessStats(sessionId: string): Promise<ProcessStats | null> {
    const session = this.sessions.get(sessionId);
    if (!session?.paneId) return null;
    try {
      const response = record(await this.run(['pane', 'process-info', '--pane', session.paneId]));
      const cpuPercent = numberValue(response.cpu_percent) || 0;
      const memoryBytes = numberValue(response.memory_bytes) || 0;
      return {
        cpuPercent,
        memoryMB: memoryBytes / (1024 * 1024),
        childCount: numberValue(response.child_count) || 0,
        updatedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  async sendInput(sessionId: string, input: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session?.paneId) return false;
    if (input === '\u001b') {
      await this.run(['pane', 'send-keys', session.paneId, 'esc']);
      return true;
    }
    if (input === '\u0003') {
      await this.run(['pane', 'send-keys', session.paneId, 'ctrl+c']);
      return true;
    }
    const submit = /[\r\n]$/.test(input);
    const text = input.replace(/[\r\n]+$/, '');
    // A bare Enter answers a dialog (e.g. Claude's workspace trust prompt); Herdr
    // rejects `agent prompt` while the agent is blocked, so send it as a key.
    if (submit && text && session.runtimeAgentKind) await this.run(['agent', 'prompt', session.paneId, text]);
    else {
      if (text) await this.run(['pane', 'send-text', session.paneId, text]);
      if (submit) await this.run(['pane', 'send-keys', session.paneId, 'enter']);
    }
    return true;
  }

  updateSessionName(sessionId: string, name: string, source?: 'manual'): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.paneId) return false;
    const mapping = this.mappingsByTerminal.get(session.terminalId || session.muxName);
    if (!mapping) return false;
    // The mapping is authoritative after migration; restoring saved session
    // state must neither revert its name nor convert an automatic name to manual.
    if (source !== 'manual' && mapping.nameVersion === NAME_VERSION) return true;
    if (source === 'manual') {
      mapping.nameSource = 'manual';
      mapping.manualName = isShellMode(session.mode) ? name.trim() : normalizeAgentName(name, false);
      mapping.agentNameTitle = undefined;
      const occupied = new Map(this.getSessions().map((item) => [item.name || '', item.terminalId || item.muxName]));
      const canonical = isShellMode(session.mode)
        ? mapping.manualName
        : this.chooseAgentName(mapping.manualName, sessionId, session.terminalId || session.muxName, occupied, mapping);
      this.publishName(session, mapping, mapping.manualName, canonical);
      this.saveMappings();
    } else {
      session.name = name;
      mapping.name = name;
      this.saveMappings();
    }
    try {
      this.runSync(['pane', 'rename', session.paneId, session.name || name]);
      mapping.pendingPaneLabel = session.name || name;
      this.saveMappings();
    } catch (error) {
      console.warn('[HerdrMuxManager] Could not update pane label:', error);
    }
    void this.reconcileSessions().catch((error) =>
      console.warn('[HerdrMuxManager] Could not reconcile renamed session:', error)
    );
    return true;
  }

  setAttached(sessionId: string, attached: boolean): void {
    const session = this.sessions.get(sessionId);
    if (session) session.attached = attached;
  }

  registerSession(session: MuxSession): void {
    this.sessions.set(session.sessionId, session);
    if (session.terminalId || session.muxName) {
      this.mappingFor(session.terminalId || session.muxName, session.sessionId, session.createdAt);
    }
  }

  updateRespawnConfig(): void {}
  clearRespawnConfig(): void {}
  updateRalphEnabled(): void {}
  async setHistoryLimit(): Promise<void> {}

  reconcileSessions(): Promise<{ alive: string[]; dead: string[]; discovered: string[] }> {
    if (!this.reconciliation) {
      this.reconciliation = this.reconcileOnce().finally(() => {
        this.reconciliation = null;
      });
    }
    return this.reconciliation;
  }

  private async reconcileOnce(): Promise<{ alive: string[]; dead: string[]; discovered: string[] }> {
    const [panes, agents, workspaces] = await Promise.all([
      this.panes(),
      this.agents().catch((error) => {
        console.warn('[HerdrMuxManager] Could not read agent names:', error);
        return null;
      }),
      this.workspaces().catch((error) => {
        console.warn('[HerdrMuxManager] Could not read workspace names:', error);
        return null;
      }),
    ]);
    const tabLabels = await this.shellTabLabels(panes);
    const next = new Map<string, MuxSession>();
    for (const raw of panes) {
      const session = this.sessionFromPane(raw, undefined, workspaces ?? new Map(), tabLabels);
      if (session) next.set(session.sessionId, session);
    }
    const alive: string[] = [];
    const dead: string[] = [];
    const discovered: string[] = [];
    for (const [sessionId, session] of next) {
      const previous = this.sessions.get(sessionId);
      this.sessions.set(sessionId, session);
      if (!previous) {
        discovered.push(sessionId);
        this.emit('externalSessionDiscovered', session);
      } else {
        alive.push(sessionId);
        if (sessionChanged(previous, session)) this.emit('sessionUpdated', session);
      }
    }
    for (const sessionId of [...this.sessions.keys()]) {
      if (next.has(sessionId)) continue;
      this.sessions.delete(sessionId);
      dead.push(sessionId);
      this.emit('sessionDied', { sessionId });
    }
    this.emit('rosterUpdated', [...next.values()]);
    if (agents && workspaces) await this.syncAgentNames(agents);
    return { alive, dead, discovered };
  }

  startStatsCollection(intervalMs = Number(process.env.CODEMAN_HERDR_POLL_MS) || DEFAULT_POLL_MS): void {
    if (this.poller) return;
    const poll = () => {
      void this.reconcileSessions()
        .then(() => this.getSessionsWithStats())
        .then((sessions) => this.emit('statsUpdated', sessions))
        .catch((error) => this.emit('error', error));
    };
    poll();
    this.poller = setInterval(poll, Math.max(500, intervalMs));
    this.poller.unref?.();
  }

  stopStatsCollection(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  getAttachCommand(): string {
    return this.bin;
  }

  getAttachArgs(muxName: string, options?: { takeover?: boolean }): string[] {
    return ['terminal', 'attach', muxName, ...(options?.takeover ? ['--takeover'] : [])];
  }

  getWindowSize(muxName: string): { cols: number; rows: number } {
    const session = [...this.sessions.values()].find((candidate) => candidate.muxName === muxName);
    if (!session?.paneId) return { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
    try {
      const response = record(this.runSync(['pane', 'layout', '--pane', session.paneId]));
      const layout = record(response.layout);
      const pane = arrayValue(layout.panes)
        .map(record)
        .find((candidate) => stringValue(candidate.pane_id) === session.paneId);
      const rect = record(pane?.rect);
      const area = record(layout.area);
      const cols = numberValue(rect.width) || numberValue(area.width);
      const rows = numberValue(rect.height) || numberValue(area.height);
      if (cols && rows && cols > 0 && rows > 0) return { cols, rows };
    } catch {
      // Fall through to the historical attach geometry.
    }
    return { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
  }

  resizeWindow(): boolean {
    return true;
  }

  isAvailable(): boolean {
    try {
      const status = record(this.runSync(['status', 'server', '--json']));
      return status.running === true && status.compatible !== false;
    } catch {
      return false;
    }
  }

  muxSessionExists(muxName: string): boolean {
    return [...this.sessions.values()].some((session) => session.muxName === muxName);
  }

  isPaneDead(muxName: string): boolean {
    return !this.muxSessionExists(muxName);
  }

  async respawnPane(_options: RespawnPaneOptions): Promise<number | null> {
    return null;
  }

  capturePaneBuffer(muxName: string, _paneTarget?: string, opts: PaneCaptureOptions = {}): string | null {
    const session = [...this.sessions.values()].find((item) => item.muxName === muxName);
    if (!session?.paneId) return null;
    try {
      const lines = opts.fullHistory ? opts.historyLimitLines || 50_000 : 200;
      return this.runTextSync([
        'pane',
        'read',
        session.paneId,
        '--source',
        'recent',
        '--lines',
        String(lines),
        '--format',
        'ansi',
      ]);
    } catch {
      return null;
    }
  }

  captureActivePaneBuffer(muxName: string, opts?: PaneCaptureOptions): string | null {
    return this.capturePaneBuffer(muxName, undefined, opts);
  }

  capturePaneText(muxName: string): string | null {
    const session = [...this.sessions.values()].find((item) => item.muxName === muxName);
    if (!session?.paneId) return null;
    try {
      return this.runTextSync(['pane', 'read', session.paneId, '--source', 'recent-unwrapped', '--lines', '200']);
    } catch {
      return null;
    }
  }
}
