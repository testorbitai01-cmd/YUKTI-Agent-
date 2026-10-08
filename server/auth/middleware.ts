import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { forbidden, unauthorized } from '../errors.js';
import type { OperatorSession, SessionStore } from './sessions.js';

export const SESSION_COOKIE = config.isProduction ? '__Host-yukti_session' : 'yukti_session';
/** Custom header required on every state-changing UI request (a cross-site form cannot set it). */
export const CSRF_HEADER = 'x-yukti-request';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      operatorSession?: OperatorSession;
      operatorToken?: string;
    }
  }
}

export function cookieOptions(maxAgeMs?: number) {
  return { httpOnly: true, secure: config.isProduction, sameSite: 'strict' as const, path: '/', ...(maxAgeMs ? { maxAge: maxAgeMs } : {}) };
}

/** CSRF: custom header on non-GET + Origin (when present) must be ours. */
export function csrfProtection(req: Request, _res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.get(CSRF_HEADER) !== '1') throw forbidden('Missing request verification header');
  const origin = req.get('origin');
  if (origin && origin !== config.appOrigin && new URL(origin).host !== req.get('host')) throw forbidden('Cross-origin request rejected');
  next();
}

/** UI API: the operator session comes from the HTTP-only cookie. */
export function requireOperator(sessions: SessionStore) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    const session = sessions.get(token);
    if (!session) throw unauthorized('Your YUKTI session has ended. Please sign in again.');
    req.operatorSession = session;
    req.operatorToken = token;
    next();
  };
}

/** MCP endpoint: `Authorization: Bearer <operator token>` (the engine passes the run owner's token). */
export function requireBearer(sessions: SessionStore) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.get('authorization') ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    const session = sessions.get(token);
    if (!session) throw unauthorized('MCP requests need a valid operator bearer token');
    req.operatorSession = session;
    next();
  };
}
