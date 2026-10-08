/**
 * Test harness: a stub Test Orbit admin API + the real YUKTI app on ephemeral ports.
 * The agent engine reaches the MCP endpoint over real HTTP, exactly as in production.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Express } from 'express';
import type { RunView } from '../../common/types.js';
import { createApp, createDeps, type AppDeps } from '../app.js';
import { McpClient } from '../mcp/client.js';
import { TestOrbitClient } from '../testorbit/client.js';

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, unknown>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

export const ADMIN = { id: 'adm1', email: 'ops@college.edu', name: 'Ops Admin', role: 'ADMIN' as const, mustChangePassword: false };

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** Build a stub Test Orbit. `routes` registers the admin endpoints a test needs. */
export async function startStack(routes: (app: Express, calls: Recorded[]) => void, admin = ADMIN) {
  const calls: Recorded[] = [];
  const stub = express();
  stub.use(express.json());
  stub.use((req, _res, next) => {
    calls.push({ method: req.method, path: req.path, query: req.query as Record<string, unknown>, body: req.body, headers: req.headers });
    next();
  });
  stub.post('/api/auth/admin/login', (req, res) => {
    if (req.body?.password !== 'correct-horse') {
      res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
      return;
    }
    res.setHeader('Set-Cookie', 'to_admin=stub-admin-token; Path=/; HttpOnly; SameSite=Lax');
    res.json({ admin });
  });
  stub.post('/api/auth/admin/logout', (_req, res) => {
    res.status(204).end();
  });
  stub.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  // Every admin route requires the session cookie, like the real API.
  stub.use('/api/admin', (req, res, next) => {
    if (!String(req.headers.cookie ?? '').includes('to_admin=stub-admin-token')) {
      res.status(401).json({ error: { code: 'ADMIN_UNAUTHENTICATED', message: 'Admin sign-in required' } });
      return;
    }
    if (req.method !== 'GET' && req.headers['x-test-orbit-request'] !== '1') {
      res.status(403).json({ error: { code: 'CSRF_FAILED', message: 'Missing request verification header' } });
      return;
    }
    next();
  });
  routes(stub, calls);
  const testorbit = await listen(stub);

  const yukti = await listen(() => undefined);
  const deps: AppDeps = createDeps({ testorbit: new TestOrbitClient(testorbit.url), mcp: new McpClient(yukti.url) });
  yukti.server.removeAllListeners('request');
  yukti.server.on('request', createApp(deps));

  let cookie = '';
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${yukti.url}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-yukti-request': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('yukti_session='));
    if (setCookie) cookie = setCookie.split(';', 1)[0]!;
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json as Record<string, unknown> & { run: RunView; error: { code: string; message: string; fieldErrors?: Record<string, string> } }, headers: res.headers };
  };

  const login = async () => {
    const r = await api('POST', '/api/auth/login', { email: admin.email, password: 'correct-horse' });
    if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
    return cookie.split('=')[1]!; // raw operator token (also the MCP bearer token)
  };

  /** Poll the run until `until` holds (or fail after a timeout). */
  const waitFor = async (runId: string, until: (r: RunView) => boolean, timeoutMs = 8000): Promise<RunView> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await api('GET', `/api/runs/${runId}`);
      const run = r.body.run;
      if (until(run)) return run;
      if (Date.now() > deadline) throw new Error(`timed out; run is ${run.status}: ${JSON.stringify(run.steps.map((s) => [s.id, s.status, s.note ?? s.error ?? '']))}`);
      await new Promise((res) => setTimeout(res, 40));
    }
  };

  const close = async () => {
    await new Promise((r) => yukti.server.close(r));
    await new Promise((r) => testorbit.server.close(r));
  };

  return { api, login, waitFor, close, calls, yuktiUrl: yukti.url, deps, cookie: () => cookie };
}
