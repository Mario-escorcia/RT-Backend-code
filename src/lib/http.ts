import { userAgent } from '../config/env.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface FetchJsonOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** GET a JSON document with a timeout, combined with the caller's abort signal. */
export async function fetchJson<T>(url: string, { signal, timeoutMs = 12_000 }: FetchJsonOptions = {}): Promise<T> {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);

  const response = await fetch(url, {
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
    signal: AbortSignal.any(signals),
  });
  if (!response.ok) {
    throw new HttpError(response.status, `${response.status} ${response.statusText} from ${new URL(url).host}`);
  }
  return (await response.json()) as T;
}
