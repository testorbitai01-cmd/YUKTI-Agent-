import { useEffect, useRef, useState } from 'react';
import type { ApiErrorBody, RunEvent, RunView } from '../common/types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** Fetch wrapper: same-origin cookie session + the CSRF header the server requires on writes. */
export async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(method !== 'GET' ? { 'x-yukti-request': '1' } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the YUKTI server');
  }
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as (ApiErrorBody & T) | null;
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'ERROR', json?.error?.message ?? `HTTP ${res.status}`, json?.error?.fieldErrors);
  return json as T;
}

/**
 * Live run stream (SSE). EventSource reconnects by itself and sends Last-Event-ID, so the server
 * replays exactly the events we missed. `state` messages carry the full run snapshot.
 */
export function useRunStream(runId: string | null) {
  const [run, setRun] = useState<RunView | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const seen = useRef(new Set<number>());

  useEffect(() => {
    if (!runId) return;
    seen.current = new Set();
    setEvents([]);
    setRun(null);
    const es = new EventSource(`/api/runs/${runId}/events`, { withCredentials: true });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener('state', (e) => setRun(JSON.parse((e as MessageEvent<string>).data) as RunView));
    es.addEventListener('log', (e) => {
      const ev = JSON.parse((e as MessageEvent<string>).data) as RunEvent;
      if (seen.current.has(ev.seq)) return;
      seen.current.add(ev.seq);
      setEvents((all) => [...all, ev]);
    });
    return () => es.close();
  }, [runId]);

  return { run, events, connected };
}

export const fmtMs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
