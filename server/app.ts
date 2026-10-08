import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { ZodError } from 'zod';
import type { HealthView, ServiceKey } from '../common/types.js';
import { AgentEngine } from './agent/engine.js';
import { agentRouter } from './agent/routes.js';
import { WORKFLOWS } from './agent/workflows/index.js';
import { csrfProtection } from './auth/middleware.js';
import { authRouter } from './auth/routes.js';
import { SessionStore } from './auth/sessions.js';
import { config } from './config.js';
import { AppError } from './errors.js';
import { McpClient } from './mcp/client.js';
import { ALL_TOOLS, findTool } from './mcp/registry.js';
import { mcpRouter } from './mcp/server.js';
import { TestOrbitClient } from './testorbit/client.js';

export interface AppDeps {
  testorbit: TestOrbitClient;
  sessions: SessionStore;
  mcp: McpClient;
  engine: AgentEngine;
}

export function createDeps(overrides: Partial<Pick<AppDeps, 'testorbit' | 'mcp'>> = {}): AppDeps {
  const testorbit = overrides.testorbit ?? new TestOrbitClient(config.testorbitApiUrl);
  const mcp = overrides.mcp ?? new McpClient(config.mcpBaseUrl);
  const sessions = new SessionStore();
  const engine = new AgentEngine(WORKFLOWS, mcp, (name) => {
    const t = findTool(name);
    return t && { name: t.name, title: t.title, service: t.service, risk: t.risk, requiresApproval: t.requiresApproval, idempotent: t.idempotent };
  });
  return { testorbit, sessions, mcp, engine };
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY > 0) app.set('trust proxy', config.TRUST_PROXY);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'font-src': ["'self'", 'data:'],
          'object-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'upgrade-insecure-requests': config.isProduction ? [] : null,
        },
      },
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', async (_req, res) => {
    const testorbit = await deps.testorbit.health();
    const services = { questions: 0, candidates: 0, proctoring: 0, analytics: 0 } as Record<ServiceKey, number>;
    for (const t of ALL_TOOLS) services[t.service] += 1;
    const body: HealthView = {
      status: testorbit.reachable ? 'ok' : 'degraded',
      version: config.version,
      testorbit: { url: config.testorbitApiUrl, ...testorbit },
      mcp: { endpoint: '/mcp', tools: ALL_TOOLS.length, services },
    };
    res.status(testorbit.reachable ? 200 : 503).json(body);
  });

  app.use('/mcp', mcpRouter(deps.sessions, deps.testorbit));

  app.use('/api', csrfProtection, (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/auth', authRouter(deps.sessions, deps.testorbit));
  app.use('/api', agentRouter(deps.engine, deps.sessions, deps.testorbit, deps.mcp));
  app.use(['/api', '/mcp'], (req, _res, next) => next(new AppError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`)));

  if (fs.existsSync(path.join(config.clientDistDir, 'index.html'))) {
    app.use(
      express.static(config.clientDistDir, {
        index: false,
        setHeaders(res, file) {
          if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        },
      }),
    );
    app.get(/^(?!\/(api|mcp)(\/|$)).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      // `root` keeps send's dot-file guard on the relative path only (the install path may contain e.g. ".vscode").
      res.sendFile('index.html', { root: config.clientDistDir });
    });
  }

  // Express identifies error handlers by arity, so `next` must stay in the signature.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {}) } });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Check the request', fieldErrors: Object.fromEntries(err.issues.map((i) => [i.path.join('.') || '_', i.message])) } });
      return;
    }
    if ((err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'MALFORMED_JSON', message: 'Malformed JSON body' } });
      return;
    }
    console.error('[yukti] unhandled error:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });

  setInterval(() => deps.sessions.purgeExpired(), 10 * 60_000).unref();
  return app;
}
