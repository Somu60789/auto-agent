import { describe, it, expect } from 'vitest';
import { createCodecovClient } from '../server/codecovClient.js';

function fakeFetch(response) {
  return async () => response;
}

describe('codecovClient', () => {
  it('returns total coverage when present', async () => {
    const client = createCodecovClient({
      fetchImpl: fakeFetch({ ok: true, json: async () => ({ totals: { coverage: 73.2 } }) }),
    });
    expect(await client.coverage('o', 'r')).toBe(73.2);
  });

  it('returns null on non-ok responses', async () => {
    const client = createCodecovClient({ fetchImpl: fakeFetch({ ok: false, json: async () => ({}) }) });
    expect(await client.coverage('o', 'r')).toBeNull();
  });

  it('returns null when totals.coverage is absent', async () => {
    const client = createCodecovClient({ fetchImpl: fakeFetch({ ok: true, json: async () => ({}) }) });
    expect(await client.coverage('o', 'r')).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const client = createCodecovClient({
      fetchImpl: async () => {
        throw new Error('network');
      },
    });
    expect(await client.coverage('o', 'r')).toBeNull();
  });
});
