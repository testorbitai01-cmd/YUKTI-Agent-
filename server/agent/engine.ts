/**
 * Agent engine — executes workflow runs as an observable state machine.
 *
 *   run:  running ⇄ awaiting_approval → completed | failed | rejected | cancelled
 *   step: pending → running ⇄ awaiting_approval → succeeded | failed | skipped | rejected
 *
 * Guarantees
 *  • A tool the registry marks `requiresApproval` never executes without an explicit human approval
 *    from the run's owner (expires after APPROVAL_TTL_MS). Only declared fields can be edited.
 *  • Only idempotent (read) tools are retried, once, on transport errors; writes are never repeated.
 *  • Every JSON-RPC exchange, agent thought and decision is an event, streamed live and replayable.
 *  • Runs live in memory (bounded). A restart ends them; nothing is resumed silently.
 */
import crypto from 'node:crypto';
import type {
  InputFieldDef,
  OperatorView,
  PendingApproval,
  RunArtifactInfo,
  RunEvent,
  RunEventType,
  RunStatus,
  RunView,
  ServiceKey,
  StepItemState,
  StepState,
  StepStatus,
  ToolRisk,
  WorkflowSummary,
} from '../../common/types.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { McpCallOutcome, McpToolInfo } from '../mcp/client.js';
import type { StepDef, ToolStep, WorkflowDefinition } from './types.js';

export const APPROVAL_TTL_MS = 30 * 60_000;
const MAX_EVENTS = 3000;
const MAX_RUNS = 200;
const MAX_ACTIVE_RUNS_PER_OPERATOR = 3;
const PREVIEW_CHARS = 6000;
const MAX_ARTIFACT_BYTES = 15 * 1024 * 1024;
const TOOLS_CACHE_MS = 60_000;
const RETRY_DELAY_MS = 800;

export interface ToolMeta {
  name: string;
  title: string;
  service: ServiceKey;
  risk: ToolRisk;
  requiresApproval: boolean;
  idempotent: boolean;
}

/** What the engine needs from MCP (McpClient implements it; tests use a fake). */
export interface ToolTransport {
  listTools(token: string): Promise<McpToolInfo[]>;
  callTool(token: string, service: ServiceKey, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallOutcome>;
}

export interface RunOwner {
  adminId: string;
  operator: OperatorView;
  token: string;
}

export type RunMessage = { kind: 'event'; event: RunEvent } | { kind: 'state'; run: RunView };
type Listener = (msg: RunMessage) => void;

type Decision =
  | { decision: 'approve'; args: Record<string, unknown>; note?: string }
  | { decision: 'reject' | 'expired' | 'cancelled'; note?: string };

interface RunState {
  id: string;
  workflow: WorkflowDefinition;
  owner: RunOwner;
  status: RunStatus;
  steps: StepState[];
  ctx: { inputs: Record<string, unknown>; outputs: Record<string, unknown>; vars: Record<string, unknown>; operator: OperatorView };
  events: RunEvent[];
  seq: number;
  listeners: Set<Listener>;
  pending: { approval: PendingApproval; resolve: (d: Decision) => void; timer: NodeJS.Timeout } | null;
  summary: RunView['summary'];
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  abort: AbortController;
  artifacts: Map<string, { info: RunArtifactInfo; text: string }>;
  toolsExecuted: number;
  totalLatencyMs: number;
  partial: boolean;
}

class StopRun extends Error {}
class RejectedRun extends Error {}
class CancelledRun extends Error {}

const DONE: StepStatus[] = ['succeeded', 'failed', 'skipped', 'rejected'];
const nowIso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Keep console payloads bounded; full outputs stay in the run context. */
export function preview(value: unknown): unknown {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  if (json === undefined || json.length <= PREVIEW_CHARS) return value;
  return { truncated: true, bytes: json.length, preview: `${json.slice(0, PREVIEW_CHARS)}…` };
}

function coerce(field: InputFieldDef, value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  if (field.type === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isFinite(n) ? n : NaN;
  }
  if (field.type === 'boolean') return value === true || value === 'true';
  return String(value).trim();
}

export class AgentEngine {
  private readonly runs = new Map<string, RunState>();
  private toolsCache: { at: number; names: Set<string> } | null = null;

  constructor(
    private readonly workflows: WorkflowDefinition[],
    private readonly transport: ToolTransport,
    private readonly catalog: (name: string) => ToolMeta | undefined,
  ) {
    for (const wf of workflows) {
      for (const step of wf.steps) {
        if (step.kind === 'tool' && !catalog(step.tool)) throw new Error(`Workflow ${wf.id} uses unknown tool ${step.tool}`);
      }
    }
  }

  // ───────────────────────────── Catalogue ─────────────────────────────

  getWorkflow(id: string): WorkflowDefinition {
    const wf = this.workflows.find((w) => w.id === id);
    if (!wf) throw notFound(`Unknown workflow "${id}"`);
    return wf;
  }

  /** Tools the MCP server currently offers (null when it cannot be reached). Cached briefly. */
  async availableTools(token: string): Promise<Set<string> | null> {
    if (this.toolsCache && Date.now() - this.toolsCache.at < TOOLS_CACHE_MS) return this.toolsCache.names;
    try {
      const names = new Set((await this.transport.listTools(token)).map((t) => t.name));
      this.toolsCache = { at: Date.now(), names };
      return names;
    } catch {
      return null;
    }
  }

  describe(wf: WorkflowDefinition, available: Set<string> | null): WorkflowSummary {
    const toolNames = wf.steps.flatMap((s) => (s.kind === 'tool' ? [s.tool] : []));
    const missingTools = available ? toolNames.filter((t) => !available.has(t)) : [];
    return {
      id: wf.id,
      title: wf.title,
      category: wf.category,
      goal: wf.goal,
      description: wf.description,
      risk: wf.risk,
      estimatedSeconds: wf.estimatedSeconds,
      inputs: wf.inputs,
      roles: wf.roles,
      notes: wf.notes,
      steps: wf.steps.map((s) => {
        const meta = s.kind === 'tool' ? this.catalog(s.tool) : undefined;
        return {
          id: s.id,
          title: s.title,
          description: s.description,
          kind: s.kind,
          tool: s.kind === 'tool' ? s.tool : undefined,
          service: meta?.service,
          risk: meta?.risk ?? 'read',
          requiresApproval: meta?.requiresApproval ?? false,
          forEach: s.kind === 'tool' && Boolean(s.forEach),
          conditional: Boolean(s.when),
        };
      }),
      availability: !available
        ? { ready: false, missingTools: [], reason: 'The MCP server could not be reached' }
        : { ready: missingTools.length === 0, missingTools, ...(missingTools.length ? { reason: `Missing MCP tools: ${missingTools.join(', ')}` } : {}) },
    };
  }

  async listWorkflows(token: string): Promise<WorkflowSummary[]> {
    const available = await this.availableTools(token);
    return this.workflows.map((wf) => this.describe(wf, available));
  }

  // ───────────────────────────── Runs ─────────────────────────────

  async start(workflowId: string, rawInputs: unknown, owner: RunOwner): Promise<RunView> {
    const wf = this.getWorkflow(workflowId);
    if (!wf.roles.includes(owner.operator.role)) throw forbidden(`This workflow needs the ${wf.roles.join(' or ')} role`);
    const parsed = wf.input.safeParse(rawInputs ?? {});
    if (!parsed.success) {
      throw badRequest('Check the highlighted inputs', Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.') || '_', i.message])));
    }
    const available = await this.availableTools(owner.token);
    const summary = this.describe(wf, available);
    if (!summary.availability.ready) throw conflict(`Cannot launch: ${summary.availability.reason}`, 'WORKFLOW_UNAVAILABLE');
    const active = [...this.runs.values()].filter((r) => r.owner.adminId === owner.adminId && !r.finishedAt).length;
    if (active >= MAX_ACTIVE_RUNS_PER_OPERATOR) throw conflict(`You already have ${active} runs in progress; finish or cancel one first`, 'TOO_MANY_RUNS');

    const run: RunState = {
      id: crypto.randomUUID(),
      workflow: wf,
      owner,
      status: 'running',
      steps: wf.steps.map((s) => ({ id: s.id, title: s.title, kind: s.kind, tool: s.kind === 'tool' ? s.tool : undefined, status: 'pending' })),
      ctx: { inputs: parsed.data, outputs: {}, vars: {}, operator: owner.operator },
      events: [],
      seq: 0,
      listeners: new Set(),
      pending: null,
      summary: null,
      error: null,
      createdAt: nowIso(),
      finishedAt: null,
      abort: new AbortController(),
      artifacts: new Map(),
      toolsExecuted: 0,
      totalLatencyMs: 0,
      partial: false,
    };
    this.runs.set(run.id, run);
    this.evictOldRuns();
    void this.execute(run);
    return this.view(run);
  }

  /** The run, if the caller owns it (others' runs look like they do not exist). */
  getRun(runId: string, adminId: string): RunState {
    const run = this.runs.get(runId);
    if (!run || run.owner.adminId !== adminId) throw notFound('Run not found');
    return run;
  }

  listRuns(adminId: string): RunView[] {
    return [...this.runs.values()]
      .filter((r) => r.owner.adminId === adminId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 25)
      .map((r) => this.view(r));
  }

  view(run: RunState): RunView {
    const done = run.steps.filter((s) => DONE.includes(s.status)).length;
    return {
      id: run.id,
      workflowId: run.workflow.id,
      workflowTitle: run.workflow.title,
      status: run.status,
      operator: run.owner.operator,
      inputs: run.ctx.inputs,
      steps: run.steps.map((s) => ({ ...s, items: s.items?.map((i) => ({ ...i })) })),
      progress: run.finishedAt ? 100 : Math.round((done / Math.max(1, run.steps.length)) * 100),
      pendingApproval: run.pending?.approval ?? null,
      summary: run.summary,
      error: run.error,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
    };
  }

  /** Replay events after `afterSeq`, then stream live. Returns an unsubscribe function. */
  subscribe(run: RunState, afterSeq: number, listener: Listener): () => void {
    for (const event of run.events) if (event.seq > afterSeq) listener({ kind: 'event', event });
    listener({ kind: 'state', run: this.view(run) });
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  decide(runId: string, adminId: string, approvalId: string, body: { decision: 'approve' | 'reject'; args?: Record<string, unknown>; note?: string }): RunView {
    const run = this.getRun(runId, adminId);
    const pending = run.pending;
    if (!pending || pending.approval.id !== approvalId) throw conflict('This approval is no longer pending', 'APPROVAL_NOT_PENDING');
    const note = body.note?.trim().slice(0, 500) || undefined;
    if (body.decision === 'reject') {
      this.resolvePending(run, { decision: 'reject', note });
      return this.view(run);
    }
    const args = { ...pending.approval.args };
    const fieldErrors: Record<string, string> = {};
    for (const field of pending.approval.editableFields) {
      if (body.args && Object.hasOwn(body.args, field.key)) {
        const v = coerce(field, body.args[field.key]);
        if (typeof v === 'number' && Number.isNaN(v)) fieldErrors[field.key] = 'Enter a number';
        else if (v === undefined) delete args[field.key];
        else args[field.key] = v;
      }
      const v = args[field.key];
      if (field.required && (v === undefined || v === '')) fieldErrors[field.key] = `${field.label} is required`;
      if (typeof v === 'number' && ((field.min !== undefined && v < field.min) || (field.max !== undefined && v > field.max))) {
        fieldErrors[field.key] = `Between ${field.min ?? '−∞'} and ${field.max ?? '∞'}`;
      }
    }
    if (Object.keys(fieldErrors).length) throw badRequest('Check the highlighted fields', fieldErrors);
    this.resolvePending(run, { decision: 'approve', args, note });
    return this.view(run);
  }

  cancel(runId: string, adminId: string): RunView {
    const run = this.getRun(runId, adminId);
    if (run.finishedAt) throw conflict('This run has already finished', 'RUN_FINISHED');
    run.abort.abort();
    if (run.pending) this.resolvePending(run, { decision: 'cancelled' });
    return this.view(run);
  }

  artifact(runId: string, adminId: string, artifactId: string) {
    const a = this.getRun(runId, adminId).artifacts.get(artifactId);
    if (!a) throw notFound('Artifact not found');
    return a;
  }

  // ───────────────────────────── Execution ─────────────────────────────

  private async execute(run: RunState): Promise<void> {
    const wf = run.workflow;
    this.emit(run, 'run.started', 'info', `Workflow "${wf.title}" started by ${run.owner.operator.name}`, { data: { inputs: run.ctx.inputs } });
    let outcome: 'completed' | 'stopped' | 'rejected' | 'failed' | 'cancelled' = 'completed';
    let stopReason: string | undefined;
    try {
      for (const [i, def] of wf.steps.entries()) {
        this.throwIfCancelled(run);
        const st = run.steps[i]!;
        if (def.when) {
          const w = def.when(run.ctx);
          if (w !== true) {
            this.finishStep(run, st, 'skipped', w);
            continue;
          }
        }
        this.startStep(run, st, def);
        if (def.kind === 'reason') {
          const r = def.think(run.ctx);
          Object.assign(run.ctx.vars, r.vars ?? {});
          for (const t of r.thoughts) this.emit(run, 'agent.thought', 'info', t, { stepId: st.id });
          this.finishStep(run, st, 'succeeded', r.stop ?? r.thoughts.at(-1));
          if (r.stop) throw new StopRun(r.stop);
          continue;
        }
        // Each step declares its own item type; at runtime items are opaque to the engine.
        await this.runToolStep(run, st, def as unknown as ToolStep<unknown>);
      }
    } catch (e) {
      if (e instanceof StopRun) {
        outcome = 'stopped';
        stopReason = e.message;
      } else if (e instanceof RejectedRun) {
        outcome = 'rejected';
      } else if (e instanceof CancelledRun || run.abort.signal.aborted) {
        outcome = 'cancelled';
      } else {
        outcome = 'failed';
        run.error = e instanceof Error ? e.message : String(e);
      }
    }

    for (const st of run.steps) {
      if (st.status === 'pending' || st.status === 'running' || st.status === 'awaiting_approval') {
        st.status = 'skipped';
        st.note ??= outcome === 'stopped' ? 'Not needed' : `Not run (${outcome})`;
      }
    }
    run.status = outcome === 'completed' || outcome === 'stopped' ? 'completed' : outcome;
    run.finishedAt = nowIso();
    let draft;
    try {
      draft = wf.summarize(run.ctx, { status: outcome, stopReason });
    } catch (e) {
      draft = { headline: `Finished (${outcome})`, highlights: [], nextActions: [] };
      console.error(`[agent] summarize failed for ${wf.id}:`, (e as Error).message);
    }
    run.summary = {
      ...draft,
      outcome: outcome === 'completed' ? (run.partial ? 'partial' : 'success') : 'stopped',
      toolsExecuted: run.toolsExecuted,
      totalLatencyMs: run.totalLatencyMs,
      artifacts: [...run.artifacts.values()].map((a) => a.info),
    };
    const level = outcome === 'failed' ? 'error' : outcome === 'completed' ? 'success' : 'warn';
    const label = { completed: 'completed', stopped: `stopped: ${stopReason}`, rejected: 'stopped: a human rejected a gated action', failed: `failed: ${run.error}`, cancelled: 'cancelled by the operator' }[outcome];
    this.emit(run, 'run.finished', level, `Run ${label}`, { data: { toolsExecuted: run.toolsExecuted, totalLatencyMs: run.totalLatencyMs } });
    run.owner = { ...run.owner, token: '' }; // the operator token is not needed any more
    this.emitState(run);
  }

  private async runToolStep(run: RunState, st: StepState, def: ToolStep<unknown>): Promise<void> {
    const meta = this.catalog(def.tool)!;
    const items: unknown[] = def.forEach ? def.forEach.items(run.ctx) : [undefined];
    if (def.forEach) {
      st.items = items.map((it) => ({ key: def.forEach!.key(it), label: def.forEach!.label(it), status: 'pending' as StepStatus }));
      if (!items.length) {
        run.ctx.outputs[st.id] = [];
        this.finishStep(run, st, 'skipped', 'Nothing to process');
        return;
      }
      this.emitState(run);
    }

    const outputs: (Record<string, unknown> | null)[] = [];
    let ok = 0;
    let rejected = 0;
    let failed = 0;
    for (const [idx, item] of items.entries()) {
      this.throwIfCancelled(run);
      const itemState = st.items?.[idx];
      let args = def.args(run.ctx, item);

      if (meta.requiresApproval) {
        const decision = await this.requestApproval(run, st, def, meta, args, item, itemState);
        if (decision.decision === 'cancelled') throw new CancelledRun();
        if (decision.decision !== 'approve') {
          const why = decision.decision === 'expired' ? 'Approval expired' : `Rejected by ${run.owner.operator.name}${decision.note ? `: ${decision.note}` : ''}`;
          rejected += 1;
          outputs.push(null);
          if (itemState) {
            itemState.status = 'rejected';
            itemState.error = why;
          }
          if (!def.forEach) {
            this.finishStep(run, st, 'rejected', why);
            throw new RejectedRun(why);
          }
          this.emitState(run);
          continue;
        }
        args = decision.args;
      }

      if (itemState) itemState.status = 'running';
      const started = performance.now();
      try {
        const data = await this.invoke(run, st, meta, args, itemState?.key);
        outputs.push(data);
        ok += 1;
        if (itemState) {
          itemState.status = 'succeeded';
          itemState.latencyMs = Math.round(performance.now() - started);
        }
        const obs = def.observe?.(data, run.ctx, item);
        for (const t of obs === undefined ? [] : Array.isArray(obs) ? obs : [obs]) this.emit(run, 'agent.thought', 'info', t, { stepId: st.id, itemKey: itemState?.key });
      } catch (e) {
        if (e instanceof CancelledRun) throw e;
        const message = e instanceof Error ? e.message : String(e);
        failed += 1;
        outputs.push(null);
        if (itemState) {
          itemState.status = 'failed';
          itemState.error = message;
        }
        if (!def.forEach) {
          run.ctx.outputs[st.id] = null;
          this.finishStep(run, st, 'failed', undefined, message);
          if (def.optional) {
            run.partial = true;
            return;
          }
          throw e;
        }
      }
      this.emitState(run);
    }

    run.ctx.outputs[st.id] = def.forEach ? outputs : outputs[0];
    if (def.forEach) {
      if (failed || rejected) run.partial = true;
      if (!ok && failed && !def.optional) {
        this.finishStep(run, st, 'failed', undefined, `All ${failed} item(s) failed`);
        throw new Error(`${st.title}: all ${failed} item(s) failed`);
      }
      const parts = [`${ok} done`, rejected ? `${rejected} rejected` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(', ');
      this.finishStep(run, st, ok ? 'succeeded' : 'rejected', parts);
      return;
    }
    const stop = def.stopIf?.(outputs[0]!, run.ctx) ?? null;
    this.finishStep(run, st, 'succeeded', stop ?? undefined);
    if (stop) throw new StopRun(stop);
  }

  /** One MCP tools/call, with a single retry for idempotent tools on transport/server errors. */
  private async invoke(run: RunState, st: StepState, meta: ToolMeta, args: Record<string, unknown>, itemKey?: string): Promise<Record<string, unknown>> {
    const attempts = meta.idempotent ? 2 : 1;
    for (let attempt = 1; ; attempt++) {
      this.emit(run, 'rpc.request', 'debug', `→ tools/call ${meta.name}`, { stepId: st.id, itemKey, data: { method: 'tools/call', params: { name: meta.name, arguments: args } } });
      const out = await this.transport.callTool(run.owner.token, meta.service, meta.name, args, run.abort.signal);
      if (run.abort.signal.aborted) throw new CancelledRun();
      run.totalLatencyMs += out.latencyMs;
      const meta2 = { stepId: st.id, itemKey, latencyMs: out.latencyMs, httpStatus: out.httpStatus };

      const retryable = out.kind === 'transport_error' || (out.kind === 'protocol_error' && out.httpStatus >= 500);
      if (out.kind !== 'result') {
        this.emit(run, 'rpc.response', 'error', `✗ ${meta.name}: ${out.message}`, { ...meta2, data: { endpoint: out.endpoint, id: out.request.id } });
        if (retryable && attempt < attempts) {
          this.emit(run, 'agent.thought', 'warn', `${meta.name} is read-only, so retrying once.`, { stepId: st.id, itemKey });
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw new Error(`${meta.name}: ${out.message}`);
      }

      run.toolsExecuted += 1;
      if (out.isError) {
        this.emit(run, 'rpc.response', 'error', `✗ ${meta.name}: ${out.text}`, { ...meta2, data: { id: out.request.id, isError: true, structuredContent: preview(out.data) } });
        throw new Error(out.text || `${meta.name} failed`);
      }
      this.emit(run, 'rpc.response', 'success', `✓ ${meta.name} · ${out.text}`, { ...meta2, data: { id: out.request.id, structuredContent: preview(out.data) } });
      for (const r of out.resources) this.storeArtifact(run, r, st.id);
      return out.data;
    }
  }

  private storeArtifact(run: RunState, r: { name: string; mimeType: string; text: string }, stepId: string) {
    const bytes = Buffer.byteLength(r.text);
    if (bytes > MAX_ARTIFACT_BYTES) {
      this.emit(run, 'agent.thought', 'warn', `${r.name} is too large to keep (${bytes} bytes); export it from the Test Orbit admin console instead.`, { stepId });
      return;
    }
    const info: RunArtifactInfo = { id: crypto.randomUUID(), name: r.name.replace(/[^\w.-]+/g, '_'), contentType: r.mimeType, bytes };
    run.artifacts.set(info.id, { info, text: r.text });
    this.emit(run, 'agent.thought', 'success', `Artifact ready: ${info.name} (${(bytes / 1024).toFixed(1)} KB)`, { stepId });
  }

  private requestApproval(run: RunState, st: StepState, def: ToolStep<unknown>, meta: ToolMeta, args: Record<string, unknown>, item: unknown, itemState?: StepItemState): Promise<Decision> {
    const spec = def.approval;
    const editable = typeof spec?.editable === 'function' ? spec.editable(run.ctx, item) : (spec?.editable ?? []);
    const requestedAt = new Date();
    const approval: PendingApproval = {
      id: crypto.randomUUID(),
      stepId: st.id,
      itemKey: itemState?.key,
      tool: meta.name,
      title: itemState ? `${def.title} — ${itemState.label}` : def.title,
      risk: meta.risk,
      prompt: spec?.prompt?.(run.ctx, args, item) ?? `High-risk MCP tool action: do you approve executing '${meta.name}'?`,
      assessment: spec?.assessment?.(run.ctx, item) ?? [],
      details: spec?.details?.(run.ctx, item) ?? [],
      args,
      editableFields: editable,
      requestedAt: requestedAt.toISOString(),
      expiresAt: new Date(requestedAt.getTime() + APPROVAL_TTL_MS).toISOString(),
    };
    run.status = 'awaiting_approval';
    st.status = 'awaiting_approval';
    if (itemState) itemState.status = 'awaiting_approval';
    return new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => this.resolvePending(run, { decision: 'expired' }), APPROVAL_TTL_MS);
      timer.unref();
      run.pending = { approval, resolve, timer };
      this.emit(run, 'approval.requested', 'warn', `⚠️ Approval required: '${meta.name}' (${meta.risk === 'critical' ? 'high risk' : meta.risk}) is waiting for your decision`, {
        stepId: st.id,
        itemKey: itemState?.key,
        data: { approvalId: approval.id, args },
      });
    });
  }

  private resolvePending(run: RunState, decision: Decision) {
    const pending = run.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    run.pending = null;
    if (decision.decision !== 'cancelled') run.status = 'running';
    const st = run.steps.find((s) => s.id === pending.approval.stepId);
    if (st && decision.decision !== 'cancelled') st.status = 'running';
    const verb = { approve: 'approved', reject: 'rejected', expired: 'expired', cancelled: 'cancelled' }[decision.decision];
    this.emit(run, 'approval.decided', decision.decision === 'approve' ? 'success' : 'warn', `Approval ${verb}: ${pending.approval.tool}${decision.note ? ` — "${decision.note}"` : ''}`, {
      stepId: pending.approval.stepId,
      itemKey: pending.approval.itemKey,
      data: decision.decision === 'approve' ? { args: decision.args, decidedBy: run.owner.operator.email } : { decidedBy: run.owner.operator.email },
    });
    pending.resolve(decision);
  }

  private startStep(run: RunState, st: StepState, def: StepDef) {
    st.status = 'running';
    st.startedAt = nowIso();
    this.emit(run, 'step.started', 'info', `▶ ${def.title}${def.kind === 'tool' ? ` (${def.tool})` : ''}`, { stepId: st.id });
  }

  private finishStep(run: RunState, st: StepState, status: StepStatus, note?: string, error?: string) {
    st.status = status;
    st.finishedAt = nowIso();
    if (st.startedAt) st.latencyMs = Date.parse(st.finishedAt) - Date.parse(st.startedAt);
    if (note) st.note = note;
    if (error) st.error = error;
    const level = status === 'failed' ? 'error' : status === 'succeeded' ? 'success' : 'warn';
    this.emit(run, 'step.finished', level, `${status === 'succeeded' ? '✔' : status === 'skipped' ? '⤼' : '✖'} ${st.title}: ${status}${note ? ` — ${note}` : ''}${error ? ` — ${error}` : ''}`, {
      stepId: st.id,
      latencyMs: st.latencyMs,
    });
  }

  private throwIfCancelled(run: RunState) {
    if (run.abort.signal.aborted) throw new CancelledRun();
  }

  private emit(
    run: RunState,
    type: RunEventType,
    level: RunEvent['level'],
    message: string,
    extra: { stepId?: string; itemKey?: string; latencyMs?: number; httpStatus?: number; data?: unknown } = {},
  ) {
    const event: RunEvent = { seq: ++run.seq, at: nowIso(), type, level, message, ...extra, data: extra.data === undefined ? undefined : preview(extra.data) };
    run.events.push(event);
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
    for (const l of run.listeners) l({ kind: 'event', event });
    if (type !== 'rpc.request' && type !== 'rpc.response' && type !== 'agent.thought') this.emitState(run);
  }

  private emitState(run: RunState) {
    const view = this.view(run);
    for (const l of run.listeners) l({ kind: 'state', run: view });
  }

  private evictOldRuns() {
    if (this.runs.size <= MAX_RUNS) return;
    const finished = [...this.runs.values()].filter((r) => r.finishedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const r of finished.slice(0, this.runs.size - MAX_RUNS)) this.runs.delete(r.id);
  }
}
