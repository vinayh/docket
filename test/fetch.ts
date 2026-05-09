/**
 * `globalThis.fetch` is typed `typeof fetch`, which on Bun carries a static
 * `preconnect` method that test fakes don't supply. Wrapping the assignment
 * lets each test write a plain async function without sprinkling
 * `as unknown as typeof fetch` casts.
 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function setFetch(fn: FetchLike): void {
  globalThis.fetch = fn as unknown as typeof fetch;
}
