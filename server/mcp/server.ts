/**
 * MCP server — JSON-RPC 2.0 over Streamable HTTP (single JSON responses; no server-initiated stream).
 *
 *   GET  /mcp, /mcp/:service   → service metadata (live check, no auth)
 *   POST /mcp, /mcp/:service   → initialize · ping · tools/list · tools/call   (Bearer operator token)
 *
 * Protocol errors are JSON-RPC errors; tool failures are results with `isError: true` (per the MCP spec),
 * so an agent can see and reason about them.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ServiceKey } from '../../common/types.js';
import { requireBearer } from '../auth/middleware.js';
import type { SessionStore } from '../auth/sessions.js';
import { config } from '../config.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { TestOrbitError, type TestOrbitClient } from '../testorbit/client.js';
import { SERVICES, isServiceKey, toolsFor } from './registry.js';
import { describeTool } from './tool.js';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const RPC = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 } as const;

type RpcId = string | number | null;

const rpcRequest = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

const callParams = z.object({ name: z.string().min(1), arguments: z.record(z.string(), z.unknown()).optional() });

function serviceOf(req: Request): ServiceKey | undefined {
  const s = (req.params as { service?: string }).service;
  if (s === undefined) return undefined;
  if (!isServiceKey(s)) throw notFound(`Unknown MCP service "${s}"`);
  return s;
}

const serverName = (service?: ServiceKey) => (service ? SERVICES[service].name : 'testorbit-unified-mcp');

/** DNS-rebinding defence recommended by the MCP transport spec: browsers must come from our origin. */
function checkOrigin(req: Request) {
  const origin = req.get('origin');
  if (origin && origin !== config.appOrigin && new URL(origin).host !== req.get('host')) throw forbidden('Origin not allowed for MCP');
}

export function mcpRouter(sessions: SessionStore, api: TestOrbitClient) {
  const router = Router();

  router.get(['/', '/:service'], (req, res) => {
    const service = serviceOf(req);
    if ((req.get('accept') ?? '').includes('text/event-stream')) {
      res.status(405).set('Allow', 'POST').end(); // no server-initiated SSE stream
      return;
    }
    const tools = toolsFor(service);
    res.json({
      service: serverName(service),
      title: service ? SERVICES[service].title : 'Test Orbit — all services',
      status: 'ONLINE',
      transport: 'streamable-http',
      protocolVersion: LATEST_PROTOCOL_VERSION,
      supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
      authentication: 'Bearer operator token (POST)',
      capabilities: { tools: { listChanged: false } },
      toolsCount: tools.length,
      tools: tools.map((t) => ({ name: t.name, title: t.title, risk: t.risk, requiresApproval: t.requiresApproval })),
    });
  });

  router.post(['/', '/:service'], (req, _res, next) => {
    checkOrigin(req);
    next();
  }, requireBearer(sessions), async (req, res) => {
    const service = serviceOf(req);
    const send = (id: RpcId, body: { result: unknown } | { error: { code: number; message: string; data?: unknown } }) => res.json({ jsonrpc: '2.0', id, ...body });

    if (Array.isArray(req.body)) {
      send(null, { error: { code: RPC.INVALID_REQUEST, message: 'JSON-RPC batching is not supported' } });
      return;
    }
    const parsed = rpcRequest.safeParse(req.body);
    if (!parsed.success) {
      send(null, { error: { code: RPC.INVALID_REQUEST, message: 'Invalid JSON-RPC 2.0 request' } });
      return;
    }
    const { id, method, params } = parsed.data;
    if (id === undefined) {
      res.status(202).end(); // notification (e.g. notifications/initialized)
      return;
    }

    switch (method) {
      case 'initialize': {
        const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : LATEST_PROTOCOL_VERSION;
        const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
        send(id, {
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: serverName(service), title: 'YUKTI — Test Orbit MCP', version: config.version },
            instructions:
              'Tools act on the live Test Orbit system as the authenticated admin. Tools marked destructive (approve re-entry, terminate, activate paper) change what candidates experience; confirm with a human first.',
          },
        });
        return;
      }
      case 'ping':
        send(id, { result: {} });
        return;
      case 'tools/list':
        send(id, { result: { tools: toolsFor(service).map(describeTool) } });
        return;
      case 'tools/call': {
        const p = callParams.safeParse(params);
        if (!p.success) {
          send(id, { error: { code: RPC.INVALID_PARAMS, message: 'tools/call needs { name, arguments }' } });
          return;
        }
        const tool = toolsFor(service).find((t) => t.name === p.data.name);
        if (!tool) {
          send(id, { error: { code: RPC.INVALID_PARAMS, message: `Unknown tool "${p.data.name}"${service ? ` for ${serverName(service)}` : ''}` } });
          return;
        }
        send(id, { result: await callTool(tool, p.data.arguments ?? {}, req, res, sessions, api) });
        return;
      }
      default:
        send(id, { error: { code: RPC.METHOD_NOT_FOUND, message: `Method "${method}" not found` } });
    }
  });

  return router;
}

const errorResult = (message: string, error: Record<string, unknown>) => ({
  content: [{ type: 'text', text: message }],
  structuredContent: { error },
  isError: true,
});

async function callTool(tool: ReturnType<typeof toolsFor>[number], rawArgs: Record<string, unknown>, req: Request, res: Response, sessions: SessionStore, api: TestOrbitClient) {
  const args = tool.input.safeParse(rawArgs);
  if (!args.success) {
    const fieldErrors = Object.fromEntries(args.error.issues.map((i) => [i.path.join('.') || '_', i.message]));
    return errorResult(`Invalid arguments for ${tool.name}: ${Object.entries(fieldErrors).map(([k, v]) => `${k}: ${v}`).join('; ')}`, { code: 'INVALID_ARGUMENTS', fieldErrors });
  }
  const session = req.operatorSession!;
  // Abort the upstream call if the client goes away.
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });
  try {
    const out = await tool.handler(args.data, { api, credential: session.credential, operator: session.operator, signal: abort.signal });
    return {
      content: [
        { type: 'text', text: out.summary },
        ...(out.resources ?? []).map((r) => ({ type: 'resource', resource: { uri: r.uri, name: r.name, mimeType: r.mimeType, text: r.text } })),
      ],
      structuredContent: out.data,
      isError: false,
    };
  } catch (e) {
    if (e instanceof TestOrbitError) {
      // Test Orbit no longer accepts this admin session: end the YUKTI session too.
      if (e.status === 401) sessions.revoke(session);
      return errorResult(e.message, { code: e.code, status: e.status, ...(e.fieldErrors ? { fieldErrors: e.fieldErrors } : {}) });
    }
    if (e instanceof AppError) return errorResult(e.message, { code: e.code, status: e.status });
    console.error(`[mcp] ${tool.name} failed:`, (e as Error).message);
    return errorResult(`${tool.name} failed unexpectedly`, { code: 'INTERNAL' });
  }
}
