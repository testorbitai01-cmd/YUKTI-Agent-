import { Router, type Request } from 'express';
import { z } from 'zod';
import type { ToolCatalog, ToolTryResult } from '../../common/types.js';
import { requireOperator } from '../auth/middleware.js';
import type { SessionStore } from '../auth/sessions.js';
import { forbidden, notFound } from '../errors.js';
import type { McpClient } from '../mcp/client.js';
import { ALL_TOOLS, SERVICES, findTool } from '../mcp/registry.js';
import { describeTool } from '../mcp/tool.js';
import type { TestOrbitClient } from '../testorbit/client.js';
import type { DomainView } from '../testorbit/types.js';
import type { AgentEngine, RunMessage } from './engine.js';

const toolCallSchema = z.object({ arguments: z.record(z.string(), z.unknown()).default({}) });

const startSchema = z.object({ workflowId: z.string().min(1).max(64), inputs: z.record(z.string(), z.unknown()).default({}) });
const decisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  args: z.record(z.string(), z.unknown()).optional(),
  note: z.string().max(500).optional(),
});
const idParam = z.string().uuid();

export function agentRouter(engine: AgentEngine, sessions: SessionStore, api: TestOrbitClient, mcp: McpClient) {
  const router = Router();
  router.use(requireOperator(sessions));

  const owner = (req: Request) => ({
    adminId: req.operatorSession!.adminId,
    operator: req.operatorSession!.operator,
    token: req.operatorToken!,
  });

  router.get('/workflows', async (req, res) => {
    res.json({ workflows: await engine.listWorkflows(req.operatorToken!) });
  });

  /** Domain picker for workflow forms (straight from Test Orbit, as the operator). */
  router.get('/lookups/domains', async (req, res) => {
    const r = await api.json<{ items: DomainView[] }>('GET', '/admin/domains', req.operatorSession!.credential);
    res.json({ domains: r.items.map((d) => ({ slug: d.slug, name: d.name, isActive: d.isActive })) });
  });

  /** MCP tool catalogue (same descriptors as tools/list, plus YUKTI's risk / approval policy). */
  router.get('/tools', (_req, res) => {
    const body: ToolCatalog = {
      services: SERVICES,
      tools: ALL_TOOLS.map((t) => {
        const d = describeTool(t);
        return { name: d.name, title: d.title, description: d.description, service: t.service, risk: t.risk, requiresApproval: t.requiresApproval, inputSchema: d.inputSchema, annotations: d.annotations };
      }),
    };
    res.json(body);
  });

  /**
   * Try a tool from the catalogue — read-only tools only. Anything that changes data (or exports
   * personal data) runs only inside a workflow, behind its approval gate.
   */
  router.post('/tools/:name/call', async (req, res) => {
    const tool = findTool(z.string().max(80).parse(req.params.name));
    if (!tool) throw notFound('Unknown tool');
    if (tool.risk !== 'read' || tool.requiresApproval) throw forbidden(`${tool.name} changes data or needs approval, so it only runs inside a workflow with an approval gate.`);
    const { arguments: args } = toolCallSchema.parse(req.body ?? {});
    const out = await mcp.callTool(req.operatorToken!, tool.service, tool.name, args);
    const result: ToolTryResult =
      out.kind === 'result'
        ? { kind: 'result', isError: out.isError, text: out.text, data: out.data, httpStatus: out.httpStatus, latencyMs: out.latencyMs, endpoint: out.endpoint, request: out.request }
        : { kind: out.kind, message: out.message, httpStatus: out.httpStatus, latencyMs: out.latencyMs, endpoint: out.endpoint, request: out.request };
    res.json({ result });
  });

  router.get('/runs', (req, res) => {
    res.json({ runs: engine.listRuns(req.operatorSession!.adminId) });
  });

  router.post('/runs', async (req, res) => {
    const { workflowId, inputs } = startSchema.parse(req.body);
    res.status(201).json({ run: await engine.start(workflowId, inputs, owner(req)) });
  });

  router.get('/runs/:runId', (req, res) => {
    res.json({ run: engine.view(engine.getRun(idParam.parse(req.params.runId), req.operatorSession!.adminId)) });
  });

  /** Live run stream (SSE). Replays events after Last-Event-ID / ?after, then streams; `state` carries the run snapshot. */
  router.get('/runs/:runId/events', (req, res) => {
    const run = engine.getRun(idParam.parse(req.params.runId), req.operatorSession!.adminId);
    const after = Number(req.get('last-event-id') ?? req.query.after ?? 0) || 0;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const write = (m: RunMessage) => {
      if (m.kind === 'event') res.write(`id: ${m.event.seq}\nevent: log\ndata: ${JSON.stringify(m.event)}\n\n`);
      else res.write(`event: state\ndata: ${JSON.stringify(m.run)}\n\n`);
    };
    const unsubscribe = engine.subscribe(run, after, write);
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  router.post('/runs/:runId/approvals/:approvalId', (req, res) => {
    const body = decisionSchema.parse(req.body);
    res.json({ run: engine.decide(idParam.parse(req.params.runId), req.operatorSession!.adminId, idParam.parse(req.params.approvalId), body) });
  });

  router.post('/runs/:runId/cancel', (req, res) => {
    res.json({ run: engine.cancel(idParam.parse(req.params.runId), req.operatorSession!.adminId) });
  });

  router.get('/runs/:runId/artifacts/:artifactId', (req, res) => {
    const a = engine.artifact(idParam.parse(req.params.runId), req.operatorSession!.adminId, idParam.parse(req.params.artifactId));
    res.setHeader('Content-Type', `${a.info.contentType}; charset=utf-8`);
    res.setHeader('Content-Disposition', `attachment; filename="${a.info.name}"`);
    res.setHeader('Cache-Control', 'no-store, private');
    // UTF-8 BOM so Excel detects the encoding of CSV downloads.
    res.send(a.info.contentType.includes('csv') ? String.fromCharCode(0xfeff) + a.text : a.text);
  });

  return router;
}
