/**
 * Test Orbit admin API client.
 *
 * YUKTI never touches the Test Orbit database. Every action goes through the same REST API the
 * admin console uses, authenticated as the operator who signed in to YUKTI — so Test Orbit's role
 * checks, validation, session row locks and audit log (attributed to that admin) all still apply.
 */
import { AppError } from '../errors.js';

/** Test Orbit's CSRF guard: every state-changing request must carry this header (shared/src/constants.ts). */
export const TESTORBIT_CSRF_HEADER = 'x-test-orbit-request';
const TIMEOUT_MS = 20_000;
const ADMIN_COOKIE = /^(__Host-)?to_admin$/;

export interface TestOrbitAdmin {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'REVIEWER';
  mustChangePassword: boolean;
}

/** An authenticated Test Orbit admin session (the session cookie, held server-side only). */
export interface TestOrbitCredential {
  cookie: string;
}

/** A Test Orbit API error, carrying its HTTP status, error code and field errors. */
export class TestOrbitError extends AppError {
  constructor(status: number, code: string, message: string, fieldErrors?: Record<string, string>) {
    super(status, code, message, fieldErrors);
    this.name = 'TestOrbitError';
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
}

/** Pick the admin session cookie out of Set-Cookie headers (name=value only). */
export function extractAdminCookie(setCookies: string[]): string | null {
  for (const header of setCookies) {
    const pair = header.split(';', 1)[0]!.trim();
    const eq = pair.indexOf('=');
    if (eq > 0 && ADMIN_COOKIE.test(pair.slice(0, eq)) && pair.length > eq + 1) return pair;
  }
  return null;
}

/** Test Orbit prefixes CSV downloads with a UTF-8 BOM (for Excel). */
const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

export class TestOrbitClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string, query?: Query): string {
    const u = new URL(`/api${path}`, this.baseUrl);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    return u.toString();
  }

  private async send(method: string, path: string, credential: TestOrbitCredential | null, opts: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json, text/csv' };
    if (method !== 'GET') headers[TESTORBIT_CSRF_HEADER] = '1';
    if (credential) headers.Cookie = credential.cookie;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
    try {
      return await this.fetchImpl(this.url(path, opts.query), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal,
        redirect: 'manual',
      });
    } catch (e) {
      const timedOut = (e as Error).name === 'TimeoutError';
      throw new TestOrbitError(timedOut ? 504 : 502, timedOut ? 'TESTORBIT_TIMEOUT' : 'TESTORBIT_UNREACHABLE', timedOut ? 'Test Orbit did not respond in time' : 'Test Orbit is unreachable');
    }
  }

  private static async fail(res: Response): Promise<never> {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: { fieldErrors?: Record<string, string> } } } | null;
    throw new TestOrbitError(
      res.status,
      body?.error?.code ?? `HTTP_${res.status}`,
      body?.error?.message ?? `Test Orbit returned HTTP ${res.status}`,
      body?.error?.details?.fieldErrors,
    );
  }

  /** Sign in as a Test Orbit admin; returns the admin and the session cookie (kept server-side). */
  async login(email: string, password: string): Promise<{ admin: TestOrbitAdmin; credential: TestOrbitCredential }> {
    const res = await this.send('POST', '/auth/admin/login', null, { body: { email, password } });
    if (!res.ok) await TestOrbitClient.fail(res);
    const cookie = extractAdminCookie(res.headers.getSetCookie());
    if (!cookie) throw new TestOrbitError(502, 'TESTORBIT_NO_SESSION', 'Test Orbit did not issue an admin session');
    const { admin } = (await res.json()) as { admin: TestOrbitAdmin };
    return { admin, credential: { cookie } };
  }

  async logout(credential: TestOrbitCredential): Promise<void> {
    await this.send('POST', '/auth/admin/logout', credential).catch(() => undefined);
  }

  async json<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, credential: TestOrbitCredential, opts: RequestOptions = {}): Promise<T> {
    const res = await this.send(method, path, credential, opts);
    if (!res.ok) await TestOrbitClient.fail(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async text(path: string, credential: TestOrbitCredential, opts: RequestOptions = {}): Promise<{ text: string; contentType: string; filename: string | null }> {
    const res = await this.send('GET', path, credential, opts);
    if (!res.ok) await TestOrbitClient.fail(res);
    const disposition = res.headers.get('content-disposition') ?? '';
    return {
      text: stripBom(await res.text()),
      contentType: res.headers.get('content-type') ?? 'text/plain',
      filename: /filename="([^"]+)"/.exec(disposition)?.[1] ?? null,
    };
  }

  /** Unauthenticated liveness probe (Test Orbit's /api/health). */
  async health(): Promise<{ reachable: boolean; latencyMs: number | null }> {
    const started = performance.now();
    try {
      const res = await this.fetchImpl(this.url('/health'), { signal: AbortSignal.timeout(5000) });
      return { reachable: res.ok, latencyMs: Math.round(performance.now() - started) };
    } catch {
      return { reachable: false, latencyMs: null };
    }
  }
}
