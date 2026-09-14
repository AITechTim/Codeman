import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { devices, type Browser, type BrowserContext, type Page } from 'playwright';
import type { WebServer } from '../../src/web/server.js';
import { createTestServer, stopTestServer } from './helpers/server.js';
import { closeAllBrowsers, getBrowser } from './helpers/browser.js';
import { PORTS } from './helpers/constants.js';

const PORT = PORTS.VOICE_INPUT;

describe('Android Chrome voice input', () => {
  let server: WebServer;
  let browser: Browser;
  beforeAll(async () => {
    server = await createTestServer(PORT);
    browser = await getBrowser('chromium');
  });
  afterAll(async () => {
    await closeAllBrowsers();
    if (server) await stopTestServer(server);
  });

  async function open(): Promise<{ page: Page; context: BrowserContext }> {
    const context = await browser.newContext({ ...devices['Pixel 7'] });
    await context.addInitScript(`
      window.voiceRecognitions = [];
      window.SpeechRecognition = class {
        constructor() { window.voiceRecognitions.push(this); }
        start() {}
        stop() { this.stopped = true; }
        abort() { this.aborted = true; }
        result(text, isFinal) {
          this.onresult?.({resultIndex: 0, results: [Object.assign([{transcript: text}], {isFinal})]});
        }
      };
      localStorage.setItem('codeman-voice-settings', JSON.stringify({provider: 'webspeech'}));
    `);
    const page = await context.newPage();
    // Also validate packaged runtime overlays against the isolated test server.
    const assetDir = process.env.CODEMAN_VOICE_TEST_PUBLIC_DIR;
    if (assetDir) {
      const assets = readdirSync(assetDir);
      await page.route(/\/(voice-input|app)\.js(?:\?|$)/, async (route) => {
        const stem = new URL(route.request().url()).pathname.split('/').pop()!.slice(0, -3);
        const name = assets.find(
          (name) => name === `${stem}.js` || new RegExp(`^${stem}\\.[a-f0-9]+\\.js$`).test(name)
        );
        if (!name) throw new Error(`Missing packaged ${stem} asset`);
        await route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(assetDir, name)) });
      });
    }
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('typeof app !== "undefined" && app.terminal');
    // Allow initial SSE/settings to finish before starting dictation.
    await page.waitForTimeout(3500);
    await page.evaluate(`
      app.sessions.set('voice-test', {id: 'voice-test', name: 'Voice test', mode: 'codex'});
      app.activeSessionId = 'voice-test';
      app.hideWelcome();
      window.voiceDelivered = [];
      app._sendInputAsync = (id, text) => window.voiceDelivered.push({id, text});
    `);
    return { context, page };
  }

  it('keeps listening through pauses and inserts the final text into the real local echo overlay', async () => {
    const { page, context } = await open();
    try {
      await page.evaluate(`
        app._localEchoEnabled = true;
        if (!app._localEchoOverlay) app._localEchoOverlay = new LocalEchoOverlay(app.terminal);
      `);
      const mic = page.locator('#voiceInputBtnMobile');
      expect(await mic.isVisible()).toBe(true);
      await mic.tap();
      await page.waitForTimeout(3500);
      expect(await mic.getAttribute('aria-pressed')).toBe('true');
      await page.evaluate("window.voiceRecognitions[0].result('first phrase', false)");
      await page.waitForTimeout(1000);
      expect(await mic.getAttribute('aria-pressed')).toBe('true');
      await page.evaluate("window.voiceRecognitions[0].result('first phrase', true)");
      expect(await page.evaluate('app._localEchoOverlay.pendingText')).toBe('');
      await mic.tap();
      expect(await mic.isDisabled()).toBe(true);
      expect(await page.locator('.voice-preview').textContent()).toContain('Finishing');
      await page.evaluate(`
        window.voiceRecognitions[0].result('first phrase and last words', true);
        window.voiceRecognitions[0].onend();
      `);
      expect(await page.evaluate('app._localEchoOverlay.pendingText')).toBe('first phrase and last words');
      expect(await page.evaluate('window.voiceDelivered')).toEqual([]);
      expect(await mic.isDisabled()).toBe(false);
      expect(await mic.getAttribute('aria-pressed')).toBe('false');
    } finally {
      await context.close();
    }
  });

  it('inserts through terminal delivery without submitting when local echo is disabled', async () => {
    const { page, context } = await open();
    try {
      await page.evaluate('app._localEchoEnabled = false');
      await page.locator('#voiceInputBtnMobile').tap();
      await page.evaluate("window.voiceRecognitions[0].result('quick phrase', false)");
      await page.locator('#voiceInputBtnMobile').tap();
      await page.evaluate('window.voiceRecognitions[0].onend()');
      expect(await page.evaluate('window.voiceDelivered')).toEqual([{ id: 'voice-test', text: 'quick phrase' }]);
    } finally {
      await context.close();
    }
  });

  it('restarts Android phrase recognition and preserves repeated words without duplicate delivery', async () => {
    const { page, context } = await open();
    try {
      await page.evaluate('app._localEchoEnabled = false');
      await page.locator('#voiceInputBtnMobile').tap();
      expect(await page.evaluate('window.voiceRecognitions[0].continuous')).toBe(false);
      await page.evaluate(`
        window.voiceRecognitions[0].result('hello', false);
        window.voiceRecognitions[0].result('hello hello', false);
        window.voiceRecognitions[0].result('hello hello', true);
        window.voiceRecognitions[0].result('hello hello', true);
        window.voiceRecognitions[0].onend();
      `);
      await page.waitForFunction(() => (window as any).voiceRecognitions.length === 2);
      expect(await page.locator('#voiceInputBtnMobile').getAttribute('aria-pressed')).toBe('true');
      expect(await page.evaluate('window.voiceRecognitions[1].continuous')).toBe(false);
      await page.evaluate("window.voiceRecognitions[1].result('second phrase', false)");
      expect(await page.evaluate('window.voiceDelivered')).toEqual([]);
      await page.locator('#voiceInputBtnMobile').tap();
      await page.evaluate(`
        window.voiceRecognitions[1].result('second phrase complete', true);
        window.voiceRecognitions[1].onend();
      `);
      expect(await page.evaluate('window.voiceDelivered')).toEqual([
        { id: 'voice-test', text: 'hello hello second phrase complete' },
      ]);
    } finally {
      await context.close();
    }
  });

  it('retains a literal editable draft across a session switch and blocks sending to the wrong session', async () => {
    const { page, context } = await open();
    try {
      await page.locator('#voiceInputBtnMobile').tap();
      await page.evaluate(`
        window.voiceRecognitions[0].result('save <tag> &amp; words', false);
        app._cleanupPreviousSession('different');
        app.activeSessionId = 'different';
      `);
      const textarea = page.locator('.voice-compose-overlay textarea');
      expect(await textarea.inputValue()).toBe('save <tag> &amp; words');
      await page.locator('.voice-compose-overlay .paste-send').tap();
      expect(await page.evaluate('window.voiceDelivered')).toEqual([]);
      expect(await textarea.isVisible()).toBe(true);
      await page.evaluate("app.activeSessionId = 'voice-test'");
      await page.locator('.voice-compose-overlay .paste-send').tap();
      expect(await page.evaluate('window.voiceDelivered')).toEqual([
        { id: 'voice-test', text: 'save <tag> &amp; words\r' },
      ]);
    } finally {
      await context.close();
    }
  });
});
