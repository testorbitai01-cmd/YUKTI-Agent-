/**
 * Operator sessions.
 *
 * An operator signs in to YUKTI with their Test Orbit admin account. YUKTI signs in to Test Orbit on
 * their behalf and keeps that admin session cookie server-side; the browser only receives an opaque
 * YUKTI token (HTTP-only cookie). The same token authorises the agent engine's MCP calls for runs the
 * operator started, so every tool call executes — and is audit-logged in Test Orbit — as that admin.
 *
 * In memory by design: sessions end on restart (operators sign in again; runs are not resumed).
 */
import crypto from 'node:crypto';
import type { OperatorRole, OperatorView } from '../../common/types.js';
import type { TestOrbitCredential } from '../testorbit/client.js';

export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000; // mirrors Test Orbit's admin idle timeout
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;

export interface OperatorSession {
  readonly key: string;
  readonly adminId: string;
  readonly operator: OperatorView;
  readonly credential: TestOrbitCredential;
  readonly createdAt: number;
  lastSeenAt: number;
}

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export class SessionStore {
  private readonly sessions = new Map<string, OperatorSession>();

  create(admin: { id: string; name: string; email: string; role: OperatorRole }, credential: TestOrbitCredential): { token: string; session: OperatorSession } {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const session: OperatorSession = {
      key: hash(token),
      adminId: admin.id,
      operator: { name: admin.name, email: admin.email, role: admin.role },
      credential,
      createdAt: now,
      lastSeenAt: now,
    };
    this.sessions.set(session.key, session);
    return { token, session };
  }

  /** Resolve a token; expired sessions are removed. */
  get(token: string | undefined | null): OperatorSession | null {
    if (!token || token.length > 128) return null;
    const session = this.sessions.get(hash(token));
    if (!session) return null;
    const now = Date.now();
    if (now - session.lastSeenAt > SESSION_IDLE_MS || now - session.createdAt > SESSION_ABSOLUTE_MS) {
      this.sessions.delete(session.key);
      return null;
    }
    session.lastSeenAt = now;
    return session;
  }

  delete(token: string | undefined | null): OperatorSession | null {
    const session = token ? (this.sessions.get(hash(token)) ?? null) : null;
    if (session) this.sessions.delete(session.key);
    return session;
  }

  /** Drop a session whose Test Orbit login is no longer valid (e.g. revoked by an admin). */
  revoke(session: OperatorSession): void {
    this.sessions.delete(session.key);
  }

  purgeExpired(now = Date.now()): void {
    for (const [key, s] of this.sessions) {
      if (now - s.lastSeenAt > SESSION_IDLE_MS || now - s.createdAt > SESSION_ABSOLUTE_MS) this.sessions.delete(key);
    }
  }
}
