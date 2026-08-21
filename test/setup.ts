import { beforeEach, vi } from 'vitest';
import { MAX_RETRIES } from '../src/lib/client.js';

// Mock fetch globally for all tests
global.fetch = vi.fn();

// Reset all mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Helper to mock a successful fetch response
 */
export function mockFetchSuccess(data: any, status = 200) {
  (global.fetch as any).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => data,
  });
}

/**
 * Helper to mock a failed fetch response.
 *
 * The client retries transient failures — 429 always, 5xx on idempotent methods
 * — so a single queued response would be consumed by the first attempt and the
 * retry would hit an unmocked fetch. Queue one response per attempt the client
 * is allowed to make, so it exhausts its retries and surfaces the real error.
 */
export function mockFetchError(status: number, message: string, data?: any) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const makeResponse = () => ({
    ok: false,
    status,
    statusText: message,
    headers: {
      get: (key: string) => headers.get(key),
    },
    json: async () => data || { error: message },
  });

  const retryable = status === 429 || (status >= 500 && status < 600);
  const attempts = retryable ? 1 + MAX_RETRIES : 1;

  for (let i = 0; i < attempts; i++) {
    (global.fetch as any).mockResolvedValueOnce(makeResponse());
  }
}

/**
 * Helper to create a mock environment object
 */
export function createMockEnv(apiKey = 'test-api-key'): any {
  return {
    HEVY_API_KEY: apiKey,
  };
}
