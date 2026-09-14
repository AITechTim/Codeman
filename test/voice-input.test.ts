import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../src/web/public/voice-input.js', import.meta.url), 'utf8');

function harness(provider = 'webspeech', userAgent = '') {
  const recognitions: any[] = [];
  const sockets: any[] = [];
  const recorders: any[] = [];
  class Recognition {
    onresult: any;
    onerror: any;
    onend: any;
    start = vi.fn();
    stop = vi.fn();
    abort = vi.fn();
    constructor() {
      recognitions.push(this);
    }
    result(...phrases: [string, boolean][]) {
      this.onresult?.({
        resultIndex: 0,
        results: phrases.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })),
      });
    }
  }
  class Socket {
    static OPEN = 1;
    static CLOSING = 2;
    readyState = 0;
    onopen: any;
    onmessage: any;
    onclose: any;
    send = vi.fn();
    close = vi.fn(() => {
      this.readyState = 3;
    });
    constructor() {
      sockets.push(this);
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    message(data: any) {
      this.onmessage?.({ data: JSON.stringify(data) });
    }
    end() {
      this.readyState = 3;
      this.onclose?.({ code: 1000 });
    }
  }
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    state = 'inactive';
    ondataavailable: any;
    onstop: any;
    start() {
      this.state = 'recording';
    }
    stop = vi.fn(() => {
      this.state = 'inactive';
      setTimeout(() => {
        this.ondataavailable?.({ data: { size: 42, lastChunk: true } });
        this.onstop?.();
      }, 0);
    });
    constructor() {
      recorders.push(this);
    }
  }
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  const app = {
    activeSessionId: 'original',
    showToast: vi.fn(),
    sendInput: vi.fn().mockResolvedValue(undefined),
    _localEchoEnabled: false,
  };
  const context = vm.createContext({
    window: { SpeechRecognition: Recognition },
    navigator: { userAgent, mediaDevices: { getUserMedia } },
    location: { protocol: 'https:', host: 'localhost' },
    localStorage: { getItem: () => JSON.stringify({ provider, apiKey: 'test-key' }) },
    app,
    URLSearchParams,
    WebSocket: Socket,
    MediaRecorder: Recorder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
  });
  const { voice, claude } = vm.runInContext(source + '\n({ voice: VoiceInput, claude: ClaudeVoiceProvider })', context);
  for (const method of [
    '_showPreview',
    '_hidePreview',
    '_updateButtons',
    '_startLevelMeter',
    '_stopLevelMeter',
    '_showVoiceSendBtn',
    '_hideVoiceSendBtn',
    '_showComposeOverlay',
  ]) {
    voice[method] = vi.fn();
  }
  voice._claudeStatus = { available: true };
  // Transport tests exercise real provider lifecycle; the audio graph itself is mocked.
  claude._startCapture = vi.fn().mockResolvedValue(undefined);
  return { voice, app, recognitions, sockets, recorders, track, stream, getUserMedia };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('voice confirmation', () => {
  it('uses Android phrase recognition, retains revisions and preserves intentional repetition across phrases', () => {
    const h = harness('webspeech', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/140.0 Mobile');
    h.voice.start();
    const first = h.recognitions[0];
    expect(first.continuous).toBe(false);
    first.result(['hello', false]);
    first.result(['hello hello', false]);
    first.result(['hello hello', true]);
    first.result(['hello hello', true]);
    expect(h.voice._transcript()).toBe('hello hello');
    vi.advanceTimersByTime(2000);
    first.onend();
    vi.advanceTimersByTime(250);
    expect(h.voice.isRecording).toBe(true);
    const second = h.recognitions[1];
    expect(second.continuous).toBe(false);
    second.result(['hello hello', true]);
    h.voice.stop();
    second.onend();
    expect(h.app.sendInput).toHaveBeenCalledExactlyOnceWith('hello hello hello hello');
  });

  it('keeps native continuous recognition outside Android', () => {
    const h = harness('webspeech', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0');
    h.voice.start();
    expect(h.recognitions[0].continuous).toBe(true);
  });

  it('listens through silence, unchanged interims, and finalized phrases', () => {
    const h = harness();
    h.voice.start();
    vi.advanceTimersByTime(4000);
    expect(h.voice.isRecording).toBe(true);
    const recognition = h.recognitions[0];
    recognition.result(['first phrase', false]);
    vi.advanceTimersByTime(4000);
    expect(h.voice.isRecording).toBe(true);
    recognition.result(['first phrase', true]);
    recognition.result(['first phrase', true], ['second phrase', false]);
    expect(h.voice.isRecording).toBe(true);
    expect(h.app.sendInput).not.toHaveBeenCalled();
    expect(h.getUserMedia).not.toHaveBeenCalled();
    h.voice.stop();
    recognition.result(['first phrase', true], ['second phrase complete', true]);
    recognition.onend();
    expect(h.app.sendInput).toHaveBeenCalledExactlyOnceWith('first phrase second phrase complete');
    expect(h.voice._state).toBe('idle');
  });

  it('keeps interim text when confirmation produces no final result', () => {
    const h = harness();
    h.voice.start();
    h.recognitions[0].result(['keep these words', false]);
    h.voice.stop();
    h.voice.toggle();
    vi.advanceTimersByTime(5000);
    expect(h.app.sendInput).toHaveBeenCalledExactlyOnceWith('keep these words');
    expect(h.recognitions).toHaveLength(1);
    expect(h.recognitions[0].abort).toHaveBeenCalledOnce();
  });

  it('restarts browser endpoints and does not duplicate snapshots', () => {
    const h = harness();
    h.voice.start();
    const first = h.recognitions[0];
    first.result(['first phrase', true]);
    first.result(['first phrase', true]);
    const staleResult = first.onresult;
    vi.advanceTimersByTime(2000);
    first.onend();
    vi.advanceTimersByTime(250);
    staleResult({ results: [Object.assign([{ transcript: 'stale' }], { isFinal: true })] });
    h.recognitions[1].result(['second phrase', true]);
    h.voice.stop();
    h.recognitions[1].onend();
    expect(h.app.sendInput).toHaveBeenCalledExactlyOnceWith('first phrase second phrase');
  });

  it('confirms during a restart delay without restarting capture', () => {
    const h = harness();
    h.voice.start();
    h.recognitions[0].result(['partial', false]);
    h.recognitions[0].onend();
    h.voice.stop();
    vi.advanceTimersByTime(6000);
    expect(h.recognitions).toHaveLength(1);
    expect(h.app.sendInput).toHaveBeenCalledExactlyOnceWith('partial');
  });

  it('bounds immediate recognition failures and reports permission errors', () => {
    const h = harness();
    h.voice.start();
    for (let i = 0; i < 3; i++) {
      h.recognitions[i].onend();
      vi.advanceTimersByTime(250);
    }
    expect(h.voice.isRecording).toBe(false);
    expect(h.recognitions).toHaveLength(3);
    expect(h.app.showToast).toHaveBeenCalled();
    h.voice.start();
    h.recognitions[3].onerror({ error: 'not-allowed' });
    expect(h.voice._state).toBe('idle');
    expect(h.app.showToast).toHaveBeenLastCalledWith('Microphone access denied. Check browser settings.', 'warning');
  });

  it('reports an empty recording', () => {
    const h = harness();
    h.voice.start();
    h.voice.stop();
    h.recognitions[0].onend();
    expect(h.app.sendInput).not.toHaveBeenCalled();
    expect(h.app.showToast).toHaveBeenCalledWith('No speech recognized. Please try again.', 'warning');
  });

  it('preserves text for review on disconnect and ignores callbacks after cleanup', () => {
    const h = harness();
    h.voice.start();
    const old = h.recognitions[0];
    old.result(['saved words', false]);
    const staleEnd = old.onend;
    h.voice.cleanup();
    expect(h.voice._showComposeOverlay).toHaveBeenCalledWith('saved words', 'original');
    h.voice.start();
    staleEnd();
    expect(h.voice.isRecording).toBe(true);
    expect(h.app.sendInput).not.toHaveBeenCalled();
    expect(old.abort).toHaveBeenCalledOnce();
  });

  it('never inserts delayed text into a different session', () => {
    const h = harness();
    h.voice.start();
    h.recognitions[0].result(['original draft', false]);
    h.voice.stop();
    h.app.activeSessionId = 'different';
    h.recognitions[0].onend();
    expect(h.app.sendInput).not.toHaveBeenCalled();
    expect(h.voice._showComposeOverlay).toHaveBeenCalledWith('original draft', 'original');
  });

  it('preserves text for review on network error instead of silently dropping it', () => {
    const h = harness();
    h.voice.start();
    h.recognitions[0].result(['saved words', false]);
    h.recognitions[0].onerror({ error: 'network' });
    expect(h.voice._showComposeOverlay).toHaveBeenCalledWith('saved words', 'original');
    expect(h.app.sendInput).not.toHaveBeenCalled();
  });
});

describe.each(['deepgram', 'claude'])('%s provider lifecycle', (provider) => {
  it('keeps listening after finalized phrases, drains after confirm and inserts once', async () => {
    const h = harness(provider);
    h.voice.start();
    await vi.advanceTimersByTimeAsync(0);
    const socket = h.sockets[0];
    socket.open();
    function result(text: string, final: boolean, start = 0) {
      socket.message(
        provider === 'claude'
          ? { t: 'transcript', text, final }
          : {
              type: 'Results',
              is_final: final,
              start,
              duration: 1,
              channel: { alternatives: [{ transcript: text }] },
            }
      );
    }
    result('first phrase', true);
    result('first phrase', true);
    vi.advanceTimersByTime(10000);
    expect(h.voice.isRecording).toBe(true);
    expect(h.app.sendInput).not.toHaveBeenCalled();
    h.voice.stop();
    if (provider === 'deepgram') {
      expect(socket.send).not.toHaveBeenCalledWith(JSON.stringify({ type: 'CloseStream' }));
      vi.advanceTimersByTime(1);
      expect(socket.send.mock.calls.slice(-2)).toEqual([
        [{ size: 42, lastChunk: true }],
        [JSON.stringify({ type: 'CloseStream' })],
      ]);
      result('second phrase', true, 1);
    } else {
      expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ t: 'finalize' }));
      result('first phrase second phrase', true);
    }
    const staleMessage = socket.onmessage;
    socket.end();
    staleMessage({ data: JSON.stringify({ t: 'transcript', text: 'late', final: true }) });
    vi.advanceTimersByTime(5000);
    expect(h.app.sendInput).toHaveBeenCalledExactlyOnceWith('first phrase second phrase');
    expect(h.track.stop).toHaveBeenCalled();
  });

  it('releases permission granted after cancellation without opening a socket', async () => {
    const h = harness(provider);
    let resolvePermission: (stream: any) => void = () => {};
    h.getUserMedia.mockReturnValue(
      new Promise((resolve) => {
        resolvePermission = resolve;
      })
    );
    h.voice.start();
    h.voice.stop();
    resolvePermission(h.stream);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.track.stop).toHaveBeenCalled();
    expect(h.sockets).toHaveLength(0);
    expect(h.voice._state).toBe('idle');
  });

  it('retains interim text if the service never finishes', async () => {
    const h = harness(provider);
    h.voice.start();
    await vi.advanceTimersByTimeAsync(0);
    const socket = h.sockets[0];
    socket.open();
    socket.message(
      provider === 'claude'
        ? { t: 'transcript', text: 'unfinished', final: false }
        : {
            type: 'Results',
            is_final: false,
            channel: { alternatives: [{ transcript: 'unfinished' }] },
          }
    );
    h.voice.stop();
    vi.advanceTimersByTime(5000);
    expect(h.app.sendInput).toHaveBeenCalledExactlyOnceWith('unfinished');
    expect(socket.close).toHaveBeenCalled();
  });
});
