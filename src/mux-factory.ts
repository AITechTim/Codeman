/**
 * @fileoverview Factory for creating the terminal multiplexer (tmux).
 *
 * @module mux-factory
 */

import type { TerminalMultiplexer } from './mux-interface.js';
import { HerdrMuxManager } from './herdr-mux-manager.js';
import { TmuxManager } from './tmux-manager.js';

/**
 * Create a TerminalMultiplexer instance.
 *
 * Requires tmux to be installed. Throws with install instructions if not found.
 */
export function createMultiplexer(): TerminalMultiplexer {
  const backend = (process.env.CODEMAN_MUX_BACKEND || 'tmux').trim().toLowerCase();
  if (backend === 'herdr') {
    console.log('[MuxFactory] Using herdr backend');
    return new HerdrMuxManager();
  }
  if (backend !== 'tmux') {
    throw new Error(`Unsupported CODEMAN_MUX_BACKEND: ${backend}. Expected "tmux" or "herdr".`);
  }
  if (!TmuxManager.isTmuxAvailable()) {
    throw new Error('tmux not found. Install: sudo apt install tmux');
  }

  console.log('[MuxFactory] Using tmux backend');
  return new TmuxManager();
}
