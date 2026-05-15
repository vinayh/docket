export interface TokenProvider {
  getAccessToken(): Promise<string>;
  refreshAccessToken(): Promise<string>;
}

export class GoogleApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`${status} ${url}: ${body}`);
    this.name = "GoogleApiError";
  }
}

export async function authedFetch(
  tp: TokenProvider,
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  // The 401 retry re-uses `init` verbatim, so `init.body` must be replayable.
  // Strings, Uint8Array, ArrayBuffer, FormData, URLSearchParams, Blob are
  // fine; a ReadableStream would be consumed by the first send and the retry
  // would silently transmit an empty body.
  if (init.body instanceof ReadableStream) {
    throw new TypeError("authedFetch: init.body must be replayable, got ReadableStream");
  }
  const send = (token: string) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(url, { ...init, headers });
  };

  let res = await send(await tp.getAccessToken());
  if (res.status === 401) {
    res = await send(await tp.refreshAccessToken());
  }
  return res;
}

export async function authedJson<T>(
  tp: TokenProvider,
  url: string | URL,
  init: RequestInit = {},
): Promise<T> {
  const res = await authedFetch(tp, url, init);
  if (!res.ok) {
    throw new GoogleApiError(res.status, String(url), await res.text());
  }
  return res.json() as Promise<T>;
}
