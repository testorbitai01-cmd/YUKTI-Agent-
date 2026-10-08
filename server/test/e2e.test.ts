import { afterEach, describe, expect, it } from 'vitest';
import { startStack, type Recorded } from './testkit.js';

type Stack = Awaited<ReturnType<typeof startStack>>;
let stack: Stack | null = null;
afterEach(async () => {
  await stack?.close();
  stack = null;
});

const NOW = '2026-10-09T10:00:00.000Z';
const ASHA = { id: 'stu1', fullName: 'Asha Kumar', mobileNumber: '9876543210', collegeName: 'Orbit Institute' };
const paged = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 20 });
const scores = (total: number | null = null) => ({ mcqScore: 12, mcqMaxScore: 20, codingScore: null, codingMaxScore: 20, totalScore: total, maxScore: 40, evaluationStatus: 'PENDING_MANUAL_REVIEW' });

function detail(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    status: 'INTERRUPTED',
    statusLabel: 'Interrupted',
    paper: { id: 'p1', name: 'AI/ML Paper', domainName: 'AI/ML' },
    durationMinutes: 45,
    timeAdjustmentMinutes: 0,
    startedAt: NOW,
    submittedAt: null,
    terminationReason: null,
    lastHeartbeatAt: NOW,
    resumeCount: 0,
    remainingMs: 20 * 60_000,
    timeUsedMs: 25 * 60_000,
    scores: scores(),
    answeredCount: 6,
    totalQuestions: 10,
    sections: [],
    questions: [],
    events: [{ id: 'e1', type: 'NETWORK_OFFLINE', label: 'Network offline', ruleGroup: 'LOG_ONLY', eventCount: 1, action: 'LOGGED', warningNumber: null, details: null, createdAt: NOW }],
    reentryRequests: [],
    student: { ...ASHA, registrationNumber: 'REG001' },
    ...extra,
  };
}

/** Stub endpoints for the outage / re-entry workflow. */
function reentryRoutes(app: Parameters<Parameters<typeof startStack>[0]>[0]) {
  app.get('/api/admin/students', (req, res) => {
    res.json(paged(req.query.search === 'Kumar' ? [ASHA, { ...ASHA, id: 'stu2', fullName: 'Ravi Kumar', mobileNumber: '9876500000' }] : [ASHA]));
  });
  app.get('/api/admin/reentry', (_req, res) => {
    res.json(
      paged([
        {
          id: 'req1',
          status: 'PENDING',
          trigger: 'NETWORK_INTERRUPTION',
          createdAt: NOW,
          decidedAt: null,
          student: ASHA,
          domainName: 'AI/ML',
          session: { id: 'ses1', status: 'INTERRUPTED', statusLabel: 'Interrupted', lastAnswerSavedAt: NOW, remainingMs: 20 * 60_000, eventCount: 1 },
        },
      ]),
    );
  });
  app.get('/api/admin/assessments/ses1', (_req, res) => {
    res.json(detail('ses1'));
  });
  app.post('/api/admin/reentry/req1/decision', (_req, res) => {
    res.json({ decision: 'APPROVED', resumeCode: 'K7Q2M9XA', resumeCodeExpiresAt: '2026-10-09T11:00:00.000Z' });
  });
}

const decisions = (calls: Recorded[]) => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/decision'));

describe('authentication', () => {
  it('signs in through Test Orbit, keeps its session server-side, and protects the API and MCP', async () => {
    stack = await startStack(() => undefined);
    expect((await stack.api('GET', '/api/auth/me')).status).toBe(401);
    expect((await stack.api('POST', '/api/auth/login', { email: 'ops@college.edu', password: 'wrong' })).status).toBe(401);

    const token = await stack.login();
    const me = await stack.api('GET', '/api/auth/me');
    expect(me.body).toEqual({ operator: { name: 'Ops Admin', email: 'ops@college.edu', role: 'ADMIN' } });
    // The Test Orbit cookie never reaches the browser.
    expect(JSON.stringify(me.body)).not.toContain('stub-admin-token');

    const unauth = await fetch(`${stack.yuktiUrl}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(unauth.status).toBe(401);
    expect(token.length).toBeGreaterThan(30);
  });

  it('refuses accounts that must still change their initial password', async () => {
    stack = await startStack(() => undefined, { id: 'adm2', email: 'ops@college.edu', name: 'New Admin', role: 'ADMIN', mustChangePassword: true });
    const r = await stack.api('POST', '/api/auth/login', { email: 'ops@college.edu', password: 'correct-horse' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('rejects state-changing requests without the CSRF header', async () => {
    stack = await startStack(() => undefined);
    const r = await fetch(`${stack.yuktiUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ops@college.edu', password: 'correct-horse' }) });
    expect(r.status).toBe(403);
  });
});

describe('MCP protocol', () => {
  const rpc = async (s: Stack, token: string, body: unknown, path = '/mcp') => {
    const r = await fetch(`${s.yuktiUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: r.status, body: r.status === 202 ? null : ((await r.json()) as Record<string, any>) }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  it('negotiates the protocol, lists annotated tools per service, and reports tool errors as isError results', async () => {
    stack = await startStack(reentryRoutes);
    const token = await stack.login();

    const init = await rpc(stack, token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    expect(init.body!.result.protocolVersion).toBe('2024-11-05');
    expect((await rpc(stack, token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);

    const all = await rpc(stack, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(all.body!.result.tools.length).toBeGreaterThanOrEqual(25);
    const proctoring = await rpc(stack, token, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, '/mcp/proctoring');
    const terminate = proctoring.body!.result.tools.find((t: { name: string }) => t.name === 'terminate_session');
    expect(terminate.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(terminate.inputSchema.required).toEqual(['sessionId', 'reason']);
    expect(proctoring.body!.result.tools.every((t: { _meta: Record<string, string> }) => t._meta['yukti/service'] === 'proctoring')).toBe(true);

    const bad = await rpc(stack, token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'approve_reentry_request', arguments: { reentryId: 'req1', decisionReason: 'no' } } }, '/mcp/proctoring');
    expect(bad.body!.result.isError).toBe(true);
    expect(bad.body!.result.structuredContent.error.fieldErrors).toHaveProperty('decisionReason');
    expect(decisions(stack.calls)).toHaveLength(0);

    const wrongService = await rpc(stack, token, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'search_students', arguments: {} } }, '/mcp/proctoring');
    expect(wrongService.body!.error.code).toBe(-32602);
    expect((await rpc(stack, token, { jsonrpc: '2.0', id: 6, method: 'nope' })).body!.error.code).toBe(-32601);

    const ok = await rpc(stack, token, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'search_students', arguments: { query: 'REG001' } } }, '/mcp/candidates');
    expect(ok.body!.result).toMatchObject({ isError: false, structuredContent: { total: 1 } });
    // The call reached Test Orbit as the operator's admin session.
    expect(stack.calls.find((c) => c.path === '/api/admin/students')!.headers.cookie).toContain('to_admin=stub-admin-token');
  });

  it('answers GET live checks without authentication', async () => {
    stack = await startStack(() => undefined);
    const r = await fetch(`${stack.yuktiUrl}/mcp/questions`);
    const body = (await r.json()) as { service: string; toolsCount: number };
    expect(body.service).toBe('testorbit-questions-mcp');
    expect(body.toolsCount).toBe(7);
  });
});

describe('tool catalogue', () => {
  it('lists every tool with its policy, runs read-only tools, and refuses writes and gated tools', async () => {
    stack = await startStack(reentryRoutes);
    await stack.login();
    const catalog = await stack.api('GET', '/api/tools');
    const tools = catalog.body.tools as { name: string; risk: string; requiresApproval: boolean }[];
    expect(tools).toHaveLength(25);
    expect(tools.find((t) => t.name === 'terminate_session')).toMatchObject({ risk: 'critical', requiresApproval: true });

    const read = await stack.api('POST', '/api/tools/search_students/call', { arguments: { query: 'REG001' } });
    expect(read.status).toBe(200);
    expect(read.body.result).toMatchObject({ kind: 'result', isError: false, httpStatus: 200, data: { total: 1 } });

    for (const name of ['approve_reentry_request', 'create_paper', 'export_results_csv']) {
      expect((await stack.api('POST', `/api/tools/${name}/call`, { arguments: {} })).status).toBe(403);
    }
    expect(decisions(stack.calls)).toHaveLength(0);
  });
});

describe('outage & re-entry workflow', () => {
  it('pauses at the approval gate, applies the human’s edits, and returns the real resume code', async () => {
    stack = await startStack(reentryRoutes);
    await stack.login();
    const start = await stack.api('POST', '/api/runs', { workflowId: 'reentry-outage', inputs: { candidate: 'REG001', extraMinutes: 5 } });
    expect(start.status).toBe(201);
    const id = start.body.run.id;

    const waiting = await stack.waitFor(id, (r) => r.status === 'awaiting_approval');
    expect(waiting.pendingApproval!.tool).toBe('approve_reentry_request');
    expect(waiting.pendingApproval!.assessment.join(' ')).toMatch(/genuine outage/);
    // Nothing was approved before the human decided.
    expect(decisions(stack.calls)).toHaveLength(0);

    // Non-editable arguments cannot be smuggled in; editable ones are applied.
    await stack.api('POST', `/api/runs/${id}/approvals/${waiting.pendingApproval!.id}`, {
      decision: 'approve',
      args: { timeAdjustmentMinutes: 10, reentryId: 'someone-else' },
    });
    const done = await stack.waitFor(id, (r) => r.status === 'completed');
    expect(decisions(stack.calls)).toHaveLength(1);
    expect(decisions(stack.calls)[0]).toMatchObject({ path: '/api/admin/reentry/req1/decision', body: { decision: 'APPROVE', timeAdjustmentMinutes: 10 } });
    expect(done.summary!.highlights.find((h) => h.label === 'Resume code')!.value).toBe('K7Q2M9XA');
    expect(done.progress).toBe(100);
  });

  it('a rejected gate changes nothing and ends the run as rejected', async () => {
    stack = await startStack(reentryRoutes);
    await stack.login();
    const id = (await stack.api('POST', '/api/runs', { workflowId: 'reentry-outage', inputs: { candidate: 'REG001' } })).body.run.id;
    const waiting = await stack.waitFor(id, (r) => r.status === 'awaiting_approval');
    await stack.api('POST', `/api/runs/${id}/approvals/${waiting.pendingApproval!.id}`, { decision: 'reject', note: 'Invigilator not reachable' });
    const done = await stack.waitFor(id, (r) => r.finishedAt !== null);
    expect(done.status).toBe('rejected');
    expect(decisions(stack.calls)).toHaveLength(0);
  });

  it('stops instead of guessing when the candidate is ambiguous', async () => {
    stack = await startStack(reentryRoutes);
    await stack.login();
    const id = (await stack.api('POST', '/api/runs', { workflowId: 'reentry-outage', inputs: { candidate: 'Kumar' } })).body.run.id;
    const done = await stack.waitFor(id, (r) => r.finishedAt !== null);
    expect(done.status).toBe('completed');
    expect(done.summary!.outcome).toBe('stopped');
    expect(done.summary!.headline).toMatch(/matches 2 students/);
    expect(stack.calls.some((c) => c.path === '/api/admin/reentry')).toBe(false);
  });

  it('validates inputs and enforces run ownership', async () => {
    stack = await startStack(reentryRoutes);
    await stack.login();
    const bad = await stack.api('POST', '/api/runs', { workflowId: 'reentry-outage', inputs: { candidate: 'R', extraMinutes: 999 } });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.fieldErrors!)).toEqual(expect.arrayContaining(['candidate', 'extraMinutes']));
    expect((await stack.api('GET', '/api/runs/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});

describe('coding evaluation workflow (per-item gates)', () => {
  it('needs marks from the human for each answer and records only approved ones', async () => {
    const evaluated: Record<string, number> = {};
    stack = await startStack((app) => {
      const questions = () =>
        ['sq1', 'sq2'].map((id, i) => ({
          id,
          position: i + 9,
          section: 'E',
          sectionTitle: 'Coding',
          type: 'CODING',
          text: `Write function ${i + 1}`,
          marks: 10,
          answered: true,
          answerText: `def f${i}(): return ${i}`,
          marksAwarded: evaluated[id] ?? null,
          evaluatedAt: null,
        }));
      app.get('/api/admin/assessments', (_req, res) => {
        res.json(paged([{ id: 'ses2', student: ASHA, domainName: 'AI/ML', paperName: 'AI/ML Paper', status: 'SUBMITTED', statusLabel: 'Submitted', startedAt: NOW, submittedAt: NOW, totalScore: null, maxScore: 40, evaluationStatus: 'PENDING_MANUAL_REVIEW' }]));
      });
      app.get('/api/admin/assessments/ses2', (_req, res) => {
        const done = Object.keys(evaluated).length === 2;
        res.json(detail('ses2', { status: 'SUBMITTED', statusLabel: 'Submitted', questions: questions(), scores: { ...scores(done ? 30 : null), evaluationStatus: done ? 'COMPLETE' : 'PENDING_MANUAL_REVIEW' } }));
      });
      app.put('/api/admin/assessments/ses2/questions/:sq/evaluation', (req, res) => {
        evaluated[req.params.sq] = req.body.marksAwarded;
        res.json(detail('ses2', { status: 'SUBMITTED', questions: questions() }));
      });
      app.get('/api/admin/reports', (_req, res) => {
        res.json({ ...paged([]), summary: {} });
      });
    });
    await stack.login();
    const id = (await stack.api('POST', '/api/runs', { workflowId: 'evaluation-queue', inputs: {} })).body.run.id;

    const first = await stack.waitFor(id, (r) => r.pendingApproval?.itemKey === 'sq1');
    expect(first.pendingApproval!.details.find((d) => d.format === 'code')!.content).toContain('def f0');
    // Approving without marks is refused — the agent never invents marks.
    const noMarks = await stack.api('POST', `/api/runs/${id}/approvals/${first.pendingApproval!.id}`, { decision: 'approve' });
    expect(noMarks.status).toBe(400);
    expect(noMarks.body.error.fieldErrors).toHaveProperty('marksAwarded');
    const tooMany = await stack.api('POST', `/api/runs/${id}/approvals/${first.pendingApproval!.id}`, { decision: 'approve', args: { marksAwarded: 11 } });
    expect(tooMany.status).toBe(400);
    await stack.api('POST', `/api/runs/${id}/approvals/${first.pendingApproval!.id}`, { decision: 'approve', args: { marksAwarded: '7.5', comment: 'Correct, misses edge case' } });

    const second = await stack.waitFor(id, (r) => r.pendingApproval?.itemKey === 'sq2');
    await stack.api('POST', `/api/runs/${id}/approvals/${second.pendingApproval!.id}`, { decision: 'reject' });

    const done = await stack.waitFor(id, (r) => r.finishedAt !== null);
    expect(evaluated).toEqual({ sq1: 7.5 });
    expect(done.status).toBe('completed');
    expect(done.summary!.outcome).toBe('partial');
    expect(done.steps.find((s) => s.id === 'evaluate')!.items!.map((i) => i.status)).toEqual(['succeeded', 'rejected']);
  });
});

describe('live event stream', () => {
  it('replays the run log over SSE, including the JSON-RPC exchange', async () => {
    stack = await startStack(reentryRoutes);
    await stack.login();
    const id = (await stack.api('POST', '/api/runs', { workflowId: 'reentry-outage', inputs: { candidate: 'REG001' } })).body.run.id;
    await stack.waitFor(id, (r) => r.status === 'awaiting_approval');

    const ctrl = new AbortController();
    const res = await fetch(`${stack.yuktiUrl}/api/runs/${id}/events`, { headers: { Cookie: stack.cookie() }, signal: ctrl.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('event: state')) text += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();
    expect(text).toContain('event: log');
    expect(text).toContain('tools/call search_students');
    expect(text).toContain('approval.requested');
  });
});
