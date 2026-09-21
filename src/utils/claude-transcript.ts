/**
 * @fileoverview Does a Claude conversation transcript exist on this host?
 *
 * Claude writes one `<conversation-id>.jsonl` per conversation under
 * `<config dir>/projects/<mangled cwd>/`. Two launch decisions turn on whether
 * such a file exists: `--resume <id>` needs one, and `--session-id <id>` is
 * REFUSED when one exists (`Error: Session ID ... is already in use.`).
 *
 * The project directory name is derived from the working directory, and a case
 * that has been moved or renamed leaves its transcript under the OLD name, so
 * the search is across every project directory rather than the one that matches
 * the pane's cwd today.
 *
 * ⚠️ Existence is the whole question here, with no size floor. The create route
 * additionally requires ~4 KB before it will resume, which is a "is this
 * conversation worth resuming" judgement; for a relaunch the question is the
 * opposite one — a one-line transcript still makes `--session-id` collide.
 *
 * @dependencies none
 * @consumedby session (relaunch resume pinning)
 *
 * @module utils/claude-transcript
 */

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `<config dir>/projects`, honouring a session's relocated `CLAUDE_CONFIG_DIR`. */
export function claudeProjectsDir(configDir?: string): string {
  return join(configDir || join(homedir(), '.claude'), 'projects');
}

/**
 * True when a transcript for `conversationId` exists under any project
 * directory. Returns false for a missing projects dir or an unreadable one:
 * the caller's fallback is to skip the resume, which is the safe direction.
 */
export async function claudeTranscriptExists(conversationId: string, configDir?: string): Promise<boolean> {
  if (!conversationId) return false;
  const projectsDir = claudeProjectsDir(configDir);
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return false;
  }
  for (const projectDir of projectDirs) {
    try {
      await stat(join(projectsDir, projectDir, `${conversationId}.jsonl`));
      return true;
    } catch {
      // Not in this project directory; keep looking.
    }
  }
  return false;
}
