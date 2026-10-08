import { Router } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import type { TestOrbitClient } from '../testorbit/client.js';
import { SESSION_COOKIE, cookieOptions, requireOperator } from './middleware.js';
import { SESSION_ABSOLUTE_MS, type SessionStore } from './sessions.js';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  password: z.string().min(1).max(200),
});

export function authRouter(sessions: SessionStore, testorbit: TestOrbitClient) {
  const router = Router();

  // Test Orbit also rate-limits and locks accounts; this stops YUKTI being used to hammer it.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => config.isTest,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? 'unknown')}|${String(req.body?.email ?? '').toLowerCase().slice(0, 254)}`,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Please wait 15 minutes.' } },
  });

  router.post('/login', loginLimiter, async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const { admin, credential } = await testorbit.login(email, password);
    if (admin.mustChangePassword) {
      await testorbit.logout(credential);
      throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your initial password in the Test Orbit admin console first, then sign in here.');
    }
    // Rotate: a browser that presented an old token gets a fresh session.
    sessions.delete(req.cookies?.[SESSION_COOKIE]);
    const { token, session } = sessions.create(admin, credential);
    res.cookie(SESSION_COOKIE, token, cookieOptions(SESSION_ABSOLUTE_MS));
    res.json({ operator: session.operator });
  });

  router.post('/logout', async (req, res) => {
    const session = sessions.delete(req.cookies?.[SESSION_COOKIE]);
    if (session) await testorbit.logout(session.credential);
    res.clearCookie(SESSION_COOKIE, cookieOptions());
    res.status(204).end();
  });

  router.get('/me', requireOperator(sessions), (req, res) => {
    res.json({ operator: req.operatorSession!.operator });
  });

  return router;
}
