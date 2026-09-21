/**
 * @fileoverview Relaunching a pane must resume its conversation, not collide
 * with it, and must not resume somebody else's.
 *
 * A CLI that launches with `--session-id <id>` refuses an id that is already in
 * use (claude: `Error: Session ID ... is already in use.`), and every session
 * whose agent has been prompted owns a transcript under that id. A relaunch
 * that passes the bare launch line therefore dies on startup, the pane goes
 * dead again at once, and the conversation is stranded.
 *
 * `restartCli()` has pinned a resume id for this reason since the custom-model
 * work. The dead-pane respawn in `_setupOrAttachMuxSession()` did not, and its
 * comment said so explicitly — "Unlike the dead-pane respawn, this one kills a
 * WORKING pane whose conversation already has a transcript". That assumption is
 * what these tests refute: a pane whose agent exited has a transcript too.
 *
 * The pin is gated four ways, and most of these tests are about the gates
 * rather than the pin, because each gate stands for a way of resuming the WRONG
 * conversation or of making a working relaunch fail.
 *
 * Port: N/A
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import { getCli } from '../src/config/cli-registry/registry.js';
import { buildSpawnCommandFromRegistry } from '../src/session-cli-registry-bridge.js';
import type { MuxSession, RespawnPaneOptions, TerminalMultiplexer } from '../src/mux-interface.js';

/** Captures the options each respawn is invoked with. */
function recordingMux() {
  const calls: RespawnPaneOptions[] = [];
  const mux = {
    isAvailable: () => true,
    muxSessionExists: () => true,
    isPaneDead: () => true,
    // Called by the PTY-exit handler during teardown. Absent, it throws
    // asynchronously after the test body has already passed, which vitest
    // reports as an unhandled error rather than a failure.
    setAttached: () => {},
    respawnPane: async (options: RespawnPaneOptions) => {
      calls.push(options);
      return 4242;
    },
  };
  return { mux: mux as unknown as TerminalMultiplexer, calls };
}

const muxSession = (muxName = 'codeman-aaaa') => ({ muxName, sessionId: 'aaaa' }) as unknown as MuxSession;

const CONVERSATION = 'aaaabbbb-cccc-dddd-eeee-ffff00001111';

let configDir: string;

/** A relocated Claude config dir, so the transcript gate reads a real fixture. */
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'codeman-transcript-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

/** Write the `<id>.jsonl` Claude would have written for a conversation. */
function giveTranscript(conversationId: string): void {
  const projectDir = join(configDir, 'projects', '-tmp-case');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${conversationId}.jsonl`), '{"type":"user"}\n');
}

function localSession(extra: Record<string, unknown> = {}, mux?: TerminalMultiplexer) {
  return new Session({
    workingDir: '/tmp',
    mode: 'claude',
    useMux: true,
    mux,
    muxSession: muxSession(),
    envOverrides: { CLAUDE_CONFIG_DIR: configDir },
    ...extra,
  });
}

describe('pinning a conversation onto a relaunch', () => {
  it('pins the chain tail on the DEAD-PANE respawn, which is the bug', async () => {
    // The path a recovered `/exit`ed session takes, and the one that was
    // missing the pin. Driven through `startInteractive()` rather than asserted
    // from source: a comment claiming a thing happens is exactly what was wrong
    // here before.
    giveTranscript(CONVERSATION);
    const { mux, calls } = recordingMux();
    const session = localSession({ claudeSessionChain: [CONVERSATION] }, mux);

    await session.startInteractive();
    try {
      expect(calls).toHaveLength(1);
      expect(calls[0].resumeSessionId).toBe(CONVERSATION);
    } finally {
      await session.stop();
    }
  });

  it('pins the chain tail on a custom-model restart too', async () => {
    giveTranscript(CONVERSATION);
    const { mux, calls } = recordingMux();
    const session = localSession({ claudeSessionChain: [CONVERSATION] }, mux);

    expect(await session.restartCli()).toBe(true);

    expect(calls[0].resumeSessionId).toBe(CONVERSATION);
  });

  it('prefers the live chain tail over the launch seed', async () => {
    // `_resumeSessionId` is written once at construction and never moves, so a
    // `/clear` after launch leaves it pointing at the predecessor. Resuming
    // that would reopen an abandoned conversation and strand the live one.
    giveTranscript(CONVERSATION);
    const { mux, calls } = recordingMux();
    const session = localSession(
      { resumeSessionId: 'bbbbcccc-dddd-eeee-ffff-000011112222', claudeSessionChain: [CONVERSATION] },
      mux
    );

    expect(await session.restartCli()).toBe(true);

    expect(calls[0].resumeSessionId).toBe(CONVERSATION);
  });

  it('falls back to the launch seed when no conversation was ever recorded', async () => {
    const seed = 'bbbbcccc-dddd-eeee-ffff-000011112222';
    giveTranscript(seed);
    const { mux, calls } = recordingMux();
    const session = localSession({ resumeSessionId: seed }, mux);

    expect(await session.restartCli()).toBe(true);

    expect(calls[0].resumeSessionId).toBe(seed);
  });

  it('never resumes an id the conversation chain did not vouch for', async () => {
    // `_claudeSessionId` also holds history-CORRELATED guesses, keyed on the
    // working directory, which the chain deliberately refuses. Launching from
    // one would open and WRITE to a conversation that was never this pane's —
    // worse than the display bug that rule exists to prevent.
    giveTranscript(CONVERSATION);
    const { mux, calls } = recordingMux();
    const session = localSession({}, mux);
    session.adoptClaudeSessionId(CONVERSATION); // no firstHand flag: a guess
    expect(session.claudeSessionId).toBe(CONVERSATION);

    expect(await session.restartCli()).toBe(true);

    expect(calls[0].resumeSessionId).not.toBe(CONVERSATION);
    expect(calls[0].resumeSessionId).toBe(session.id);
  });

  it('drops a pin that no transcript backs', async () => {
    // A divergent pin renders `--resume <pin> || --session-id <this.id>`, so a
    // resume that finds nothing falls back onto the colliding form and the pane
    // dies exactly as it did before any of this. No transcript, no pin.
    const { mux, calls } = recordingMux();
    const session = localSession({ claudeSessionChain: [CONVERSATION] }, mux);

    expect(await session.restartCli()).toBe(true);

    expect(calls[0].resumeSessionId).toBeUndefined();
  });

  it('pins nothing for a remote session, whose conversation lives elsewhere', async () => {
    // The dead-pane respawn is reached by every session shape, unlike
    // `restartCli()` whose route refuses remote. A local id pinned onto a
    // remote pane resolves to nothing there, and the `--session-id` fallback
    // then collides with the transcript the remote host really does hold.
    giveTranscript(CONVERSATION);
    const { mux, calls } = recordingMux();
    const session = localSession(
      {
        remote: { hostId: 'h1', label: 'box', host: 'box', username: 'dev', remotePath: '/tmp' },
        claudeSessionChain: [CONVERSATION],
      },
      mux
    );

    await session.startInteractive();
    try {
      expect(calls[0].resumeSessionId).toBeUndefined();
    } finally {
      await session.stop();
    }
  });

  it('pins nothing for a docker case, whose pane execs into the container', async () => {
    giveTranscript(CONVERSATION);
    const { mux, calls } = recordingMux();
    const session = localSession(
      {
        docker: { hostId: 'd1', label: 'ctr', containerName: 'ctr' },
        claudeSessionChain: [CONVERSATION],
      },
      mux
    );

    await session.startInteractive();
    try {
      expect(calls[0].resumeSessionId).toBeUndefined();
    } finally {
      await session.stop();
    }
  });

  it('pins nothing for a CLI that mints its own resume id', async () => {
    // codex/pi/omp/grok declare no `fallback` chain and read their resume id
    // from their own config, so a top-level pin would be meaningless at best.
    const { mux, calls } = recordingMux();
    const session = localSession({ mode: 'codex' }, mux);

    expect(await session.restartCli()).toBe(true);

    expect(calls[0].resumeSessionId).toBeUndefined();
  });

  it('pins nothing for a remote reattach, which relaunches no CLI', async () => {
    // `reattachRemote()` re-runs the remote session command, which attaches to
    // the durable remote tmux with the agent still running inside it.
    giveTranscript(CONVERSATION);
    const { mux, calls } = recordingMux();
    const session = localSession(
      {
        remote: { hostId: 'h1', label: 'box', host: 'box', username: 'dev', remotePath: '/tmp' },
        claudeSessionChain: [CONVERSATION],
      },
      mux
    );

    expect(await session.reattachRemote()).toBe(true);

    expect(calls[0].resumeSessionId).toBeUndefined();
  });
});

describe('what the pin renders', () => {
  // The rendered command is what actually runs, and it is where each gate's
  // reason shows. Asserting here rather than counting call sites in the source
  // is what would have caught the divergent-pin and synthetic-id cases.
  const SID = '0f9c2b14-1111-2222-3333-444455556666';
  const entry = getCli('claude');
  const render = (resumeSessionId?: string) => {
    if (!entry) throw new Error('no registry entry for claude');
    return buildSpawnCommandFromRegistry(entry, {
      mode: 'claude',
      sessionId: SID,
      claudeCliVersion: null,
      resumeSessionId,
    });
  };

  it('renders the colliding bare form with no pin — the bug itself', () => {
    expect(render()).toContain(`--session-id "${SID}"`);
    expect(render()).not.toContain('--resume');
  });

  it('renders a self-healing resume-or-new when the pin is the session id', () => {
    expect(render(SID)).toBe(
      `claude --dangerously-skip-permissions --resume "${SID}" || claude --dangerously-skip-permissions --session-id "${SID}"`
    );
  });

  it('keeps the SESSION id in the fallback branch when the pin diverges', () => {
    // Which is why a pin with no transcript behind it has to be dropped: the
    // fallback is the colliding form, so a failed resume dies twice.
    expect(render(CONVERSATION)).toContain(`--resume "${CONVERSATION}"`);
    expect(render(CONVERSATION)).toContain(`--session-id "${SID}"`);
  });

  it('drops a synthetic discovered id, which fails the uuid token pattern', () => {
    // `reconcileSessions()` mints `restored-<fragment>` for a tmux session
    // Codeman found but does not own. The renderer emits the unpinned command,
    // so those panes keep the pre-existing behaviour.
    expect(render('restored-40568a29')).not.toContain('--resume');
  });
});
