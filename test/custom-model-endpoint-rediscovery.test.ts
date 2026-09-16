/**
 * @fileoverview Tests for `refreshAllCustomModelHosts()`, the periodic
 * background sweep behind server.ts's "custom model endpoint re-discovery"
 * timer (docs/custom-model-endpoints-plan.md). Kept in its own file rather
 * than folded into test/routes/custom-model-routes.test.ts: that file's data
 * dir is shared across every test in it (one temp HOME per FILE, not per
 * test — test/setup.ts), and a sweep that walks every saved host would pick
 * up every host any other test in that file happened to create, making an
 * exact call-count or exact-host assertion meaningless. A dedicated file
 * gets its own clean temp HOME.
 *
 * Port: N/A (no server; drives readCustomModelHosts/writeCustomModelHosts
 * directly plus the mocked webviewFetch dispatcher).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDataDir } from '../src/config/instance.js';
import { readCustomModelHosts, writeCustomModelHosts, type CustomModelHost } from '../src/custom-model-hosts.js';
import { refreshAllCustomModelHosts } from '../src/web/routes/custom-model-routes.js';
import { webviewFetch } from '../src/web/webview-egress.js';

vi.mock('../src/web/webview-egress.js', async () => {
  const actual = await vi.importActual<typeof import('../src/web/webview-egress.js')>('../src/web/webview-egress.js');
  return { ...actual, webviewFetch: vi.fn() };
});

const fetchMock = vi.mocked(webviewFetch);

function host(overrides: Partial<CustomModelHost> & Pick<CustomModelHost, 'id' | 'baseUrl'>): CustomModelHost {
  return { label: overrides.id, ...overrides };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('refreshAllCustomModelHosts (the periodic re-discovery sweep)', () => {
  it('refreshes every saved endpoint, best-effort — one unreachable host does not stop the others', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [
      host({ id: 'ok', baseUrl: 'http://localhost:8080' }),
      host({ id: 'down', baseUrl: 'http://localhost:8081' }),
    ]);
    fetchMock.mockImplementation(async (url: URL) => {
      if (url.href.includes('8081')) throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
      return new Response(JSON.stringify({ data: [{ id: 'qwen3' }] }), { status: 200 });
    });

    await refreshAllCustomModelHosts();

    const hosts = await readCustomModelHosts(dir);
    const ok = hosts.find((h) => h.id === 'ok');
    const down = hosts.find((h) => h.id === 'down');
    expect(ok?.models).toEqual(['qwen3']);
    expect(ok?.lastDiscoveredAt).toBeTruthy();
    expect(down?.models ?? []).toEqual([]);
    expect(down?.lastDiscoveredAt).toBeFalsy();
  });

  it('skips a host whose baseUrl is blocked, without making a request', async () => {
    const dir = getDataDir();
    // Written directly rather than through the POST route, which already
    // refuses this at save time — this simulates a record that pre-dates the
    // guard, or was hand-edited on disk. The sweep must not trust it either.
    await writeCustomModelHosts(dir, [host({ id: 'meta', baseUrl: 'http://169.254.169.254/' })]);

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'x' }] }), { status: 200 }));
    await refreshAllCustomModelHosts();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops a stale default and preserves lastDiscoveredAt semantics, same as manual discovery', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [
      host({ id: 'ep', baseUrl: 'http://localhost:8080', models: ['qwen3'], defaultModelId: 'qwen3' }),
    ]);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'llama3' }] }), { status: 200 }));

    await refreshAllCustomModelHosts();

    const [updated] = await readCustomModelHosts(dir);
    expect(updated.models).toEqual(['llama3']);
    expect(updated.defaultModelId).toBeUndefined();
    expect(updated.lastDiscoveredAt).toBeTruthy();
  });

  it('keeps a default that is still present after the sweep', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [
      host({ id: 'ep', baseUrl: 'http://localhost:8080', models: ['qwen3'], defaultModelId: 'qwen3' }),
    ]);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'qwen3' }, { id: 'llama3' }] }), { status: 200 })
    );

    await refreshAllCustomModelHosts();

    const [updated] = await readCustomModelHosts(dir);
    expect(updated.defaultModelId).toBe('qwen3');
  });

  it('does not resurrect an endpoint deleted while the sweep was in flight', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [host({ id: 'deleted', baseUrl: 'http://localhost:8080' })]);

    fetchMock.mockImplementation(async () => {
      // Simulate an admin deleting the endpoint between the sweep's fetch and
      // its read-modify-write — the delete must win, not be overwritten by a
      // refresh that started before it.
      const current = await readCustomModelHosts(dir);
      await writeCustomModelHosts(
        dir,
        current.filter((h) => h.id !== 'deleted')
      );
      return new Response(JSON.stringify({ data: [{ id: 'qwen3' }] }), { status: 200 });
    });

    await expect(refreshAllCustomModelHosts()).resolves.toBeUndefined();
    const hosts = await readCustomModelHosts(dir);
    expect(hosts.find((h) => h.id === 'deleted')).toBeUndefined();
  });

  it('leaves the store untouched when there are no saved endpoints at all', async () => {
    await expect(refreshAllCustomModelHosts()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
