import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunView } from '../../common/types.js';
import { AgentEngine, type ToolMeta, type ToolTransport } from '../agent/engine.js';
import { toolStep, type WorkflowDefinition } from '../agent/types.js';
import type { McpCallOutcome } from '../mcp/client.js';

const META: Record<string, ToolMeta> = {
  read_tool: { name: 'read_tool', title: 'Read', service: 'analytics', risk: 'read', requiresApproval: false, idempotent: true },
  write_tool: { name: 'write_tool', title: 'Write', service: 'questions', risk: 'write', requiresApproval: false, idempotent: false },
  gated_tool: { name: 'gated_tool', title: 'Gated', service: 'proctoring', risk: 'critical', requiresApproval: true, idempotent: false },
};

const ok = (data: Record<string, unknown> = {}): McpCallOutcome => ({ kind: 'result', isError: false, text: 'ok', data, resources: [], request: { jsonrpc: '2.0', id: 1, method: 'tools/call' }, endpoint: 'x', httpStatus: 200, latencyMs: 3 });
const down = (): McpCallOutcome => ({ kind: 'transport_error', message: 'MCP server unreachable', request: { jsonrpc: '2.0', id: 1, method: 'tools/call' }, endpoint: 'x', httpStatus: 0, latencyMs: 1 });

function transport(script: Record<string, McpCallOutcome[]>) {
  const calls: string[] = [];
  const t: ToolTransport = {
    listTools: async () => Object.keys(META).map((name) => ({ name })),
    callTool: async (_token, _service, name) => {
      calls.push(name);
      return script[name]!.shift() ?? ok();
    },
  };
  return { t, calls };
}

const wf = (tool: string): WorkflowDefinition => ({
  id: `wf-${tool}`,
  title: tool,
  category: 'Test',
  goal: '',
  description: '',
  risk: 'LOW',
  estimatedSeconds: 1,
  roles: ['ADMIN'],
  notes: [],
  inputs: [],
  input: z.object({}),
  steps: [toolStep({ kind: 'tool', id: 's1', title: 'Step', description: '', tool, args: () => ({}) })],
  summarize: () => ({ headline: 'done', highlights: [], nextActions: [] }),
});

const owner = { adminId: 'a1', operator: { name: 'A', email: 'a@x.io', role: 'ADMIN' as const }, token: 't' };

async function finished(engine: AgentEngine, id: string): Promise<RunView> {
  for (let i = 0; i < 200; i++) {
    const v = engine.view(engine.getRun(id, 'a1'));
    if (v.finishedAt) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('run did not finish');
}

describe('agent engine retry policy', () => {
  it('retries a read-only tool once after a transport error', async () => {
    const { t, calls } = transport({ read_tool: [down(), ok({ n: 1 })] });
    const engine = new AgentEngine([wf('read_tool')], t, (n) => META[n]);
    const run = await engine.start('wf-read_tool', {}, owner);
    const done = await finished(engine, run.id);
    expect(done.status).toBe('completed');
    expect(calls).toEqual(['read_tool', 'read_tool']);
  });

  it('never repeats a write', async () => {
    const { t, calls } = transport({ write_tool: [down(), ok()] });
    const engine = new AgentEngine([wf('write_tool')], t, (n) => META[n]);
    const done = await finished(engine, (await engine.start('wf-write_tool', {}, owner)).id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/unreachable/);
    expect(calls).toEqual(['write_tool']);
  });
});

describe('agent engine approval gates', () => {
  it('enforces the registry gate even when the workflow declares no approval, and cancels cleanly', async () => {
    const { t, calls } = transport({ gated_tool: [ok()] });
    const engine = new AgentEngine([wf('gated_tool')], t, (n) => META[n]);
    const run = await engine.start('wf-gated_tool', {}, owner);
    for (let i = 0; i < 100 && engine.view(engine.getRun(run.id, 'a1')).status !== 'awaiting_approval'; i++) await new Promise((r) => setTimeout(r, 5));
    expect(engine.view(engine.getRun(run.id, 'a1')).pendingApproval!.tool).toBe('gated_tool');
    expect(calls).toEqual([]);
    engine.cancel(run.id, 'a1');
    const done = await finished(engine, run.id);
    expect(done.status).toBe('cancelled');
    expect(calls).toEqual([]);
  });

  it('hides runs from other operators', async () => {
    const { t } = transport({ read_tool: [ok()] });
    const engine = new AgentEngine([wf('read_tool')], t, (n) => META[n]);
    const run = await engine.start('wf-read_tool', {}, owner);
    expect(() => engine.getRun(run.id, 'someone-else')).toThrow('Run not found');
  });

  it('refuses a workflow whose tools the MCP server does not offer', async () => {
    const t: ToolTransport = { listTools: async () => [], callTool: async () => ok() };
    const engine = new AgentEngine([wf('read_tool')], t, (n) => META[n]);
    await expect(engine.start('wf-read_tool', {}, owner)).rejects.toThrow(/Missing MCP tools: read_tool/);
  });
});
