import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Brain,
  Eye,
  Info,
  ListChecks,
  Loader2,
  Lock,
  Play,
  RotateCcw,
  SearchX,
  ShieldAlert,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  Zap,
} from 'lucide-react';
import type { OperatorView, RunView, WorkflowSummary } from '../../common/types';
import { ApiError, api, useRunStream } from '../api';
import { workflowIcon } from '../data/workflowsData';
import { href, navigate } from '../router';
import { RISK, RUN_STATUS, fmtDuration } from '../status';
import { ActivityFeed } from './ActivityFeed';
import { HumanApprovalModal } from './HumanApprovalModal';
import { ParameterForm, initialValues, toPayload, type DomainOption, type FieldValues } from './ParameterForm';
import { RunSummaryCard } from './RunSummaryCard';
import { TerminalConsole } from './TerminalConsole';
import { Badge, CardHeader, EmptyState, PageHeader, StatusBadge } from './ui';
import { WorkflowStepper } from './WorkflowStepper';

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Live status strip: progress, current step, tool calls, latency, elapsed time. */
function RunBar({ run, calls, latencyMs }: { run: RunView; calls: number; latencyMs: number }) {
  const live = !run.finishedAt;
  const now = useNow(live);
  const meta = RUN_STATUS[run.status];
  const idx = run.steps.findIndex((s) => s.status === 'running' || s.status === 'awaiting_approval');
  const done = run.steps.filter((s) => s.status !== 'pending').length;
  const elapsed = (run.finishedAt ? Date.parse(run.finishedAt) : now) - Date.parse(run.createdAt);
  return (
    <section className="card runbar" aria-label="Run status">
      <div className="row wrap" style={{ justifyContent: 'space-between' }}>
        <div className="row wrap">
          <StatusBadge meta={meta} running={run.status === 'running'} />
          <span className="muted" style={{ fontSize: 13 }}>
            {idx >= 0 ? `Step ${idx + 1} of ${run.steps.length}: ${run.steps[idx]!.title}` : live ? 'Starting…' : run.summary?.headline}
          </span>
        </div>
        <span className="subtle" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
          {run.progress}%
        </span>
      </div>
      <div className={`progress${run.status === 'completed' ? ' done' : run.status === 'failed' ? ' bad' : ''}`} role="progressbar" aria-valuenow={run.progress} aria-valuemin={0} aria-valuemax={100} aria-label="Run progress">
        <div style={{ width: `${run.progress}%` }} />
      </div>
      <div className="runbar-kpis">
        <div>
          <div className="k">Steps</div>
          <div className="v">
            {done} / {run.steps.length}
          </div>
        </div>
        <div>
          <div className="k">Tool calls</div>
          <div className="v">{calls}</div>
        </div>
        <div>
          <div className="k">MCP latency</div>
          <div className="v">{fmtDuration(latencyMs)}</div>
        </div>
        <div>
          <div className="k">Elapsed</div>
          <div className="v">{fmtDuration(elapsed)}</div>
        </div>
        <div>
          <div className="k">Operator</div>
          <div className="v" style={{ fontWeight: 500, fontSize: 13 }}>
            {run.operator.name}
          </div>
        </div>
      </div>
    </section>
  );
}

function HowItWorks({ wf }: { wf: WorkflowSummary }) {
  const rows = [
    { icon: Eye, tone: 'brand', title: 'Observe', text: 'Reads live Test Orbit data through MCP tools, as you.' },
    { icon: Brain, tone: 'violet', title: 'Reason', text: 'Turns the evidence into findings and a recommendation — and stops rather than guess.' },
    { icon: Lock, tone: 'warn', title: 'You approve', text: 'Every step that affects candidates pauses for your decision; you can edit or reject it.' },
    { icon: Zap, tone: 'success', title: 'Act', text: 'Executes through the Test Orbit API — validated, locked and audit-logged under your name.' },
  ] as const;
  return (
    <section className="card">
      <CardHeader icon={Info} title="How this agent works" description={wf.description} />
      <div className="card-body" style={{ display: 'grid', gap: 14 }}>
        {rows.map((r) => (
          <div key={r.title} className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
            <span className={`icon-tile ${r.tone}`} aria-hidden>
              <r.icon size={17} />
            </span>
            <div>
              <strong style={{ fontSize: 14 }}>{r.title}</strong>
              <p className="muted" style={{ fontSize: 13 }}>
                {r.text}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

interface Props {
  workflows: WorkflowSummary[] | null;
  operator: OperatorView;
  workflowId?: string;
  runId?: string;
}

export function AgenticExecutionStudio({ workflows, operator, workflowId, runId }: Props) {
  const { run, events, connected } = useRunStream(runId ?? null);
  const wf = workflows?.find((w) => w.id === (workflowId ?? run?.workflowId));
  const [values, setValues] = useState<FieldValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [domains, setDomains] = useState<DomainOption[] | null>(null);
  const [tab, setTab] = useState<'activity' | 'console'>('activity');
  const [hidden, setHidden] = useState<string | null>(null);
  const hydrated = useRef<string | null>(null);

  // Form values: workflow defaults for a new run, or the inputs a past run used.
  useEffect(() => {
    if (!wf) return;
    const key = run ? `run:${run.id}` : `wf:${wf.id}`;
    if (hydrated.current === key || (runId && !run)) return;
    hydrated.current = key;
    setValues(initialValues(wf.inputs, run?.inputs));
  }, [wf, run, runId]);

  useEffect(() => {
    if (!wf?.inputs.some((f) => f.type === 'domain')) return;
    api<{ domains: DomainOption[] }>('GET', '/lookups/domains')
      .then((r) => setDomains(r.domains))
      .catch(() => setDomains([]));
  }, [wf]);

  if (!workflows) return <div className="center pulse">Loading…</div>;
  if (runId && !run) return <div className="center"><Loader2 className="spin" /> Connecting to the run…</div>;
  if (!wf) {
    return (
      <div className="card">
        <EmptyState icon={SearchX} title="Workflow not found" description="It may have been removed, or the run ended when YUKTI restarted." action={<a className="btn secondary sm" href={href({ name: 'workflows' })}>Back to workflows</a>} />
      </div>
    );
  }

  const launch = async () => {
    setStarting(true);
    setError(null);
    setErrors({});
    try {
      const r = await api<{ run: RunView }>('POST', '/runs', { workflowId: wf.id, inputs: toPayload(wf.inputs, values) });
      setHidden(null);
      navigate({ name: 'run', id: r.run.id });
    } catch (e) {
      if (e instanceof ApiError) {
        setErrors(e.fieldErrors);
        setError(e.message);
      } else setError('Could not start the workflow');
    } finally {
      setStarting(false);
    }
  };
  const cancel = () => void (runId && api('POST', `/runs/${runId}/cancel`).catch(() => undefined));

  const live = Boolean(run && !run.finishedAt);
  const pending = run?.pendingApproval ?? null;
  const showModal = Boolean(pending && hidden !== pending.id && runId);
  const Icon = workflowIcon(wf.id);
  const risk = RISK[wf.risk];
  const gates = wf.steps.filter((s) => s.requiresApproval).length;
  const canLaunch = wf.availability.ready && wf.roles.includes(operator.role);

  return (
    <>
      <PageHeader
        back={runId ? { label: 'Runs', href: href({ name: 'runs' }) } : { label: 'Workflows', href: href({ name: 'workflows' }) }}
        title={
          <>
            <span className="icon-tile brand" aria-hidden>
              <Icon size={18} />
            </span>
            {wf.title}
          </>
        }
        description={wf.goal}
        actions={
          live ? (
            <button className="btn secondary" onClick={cancel}>
              <Square size={14} /> Cancel run
            </button>
          ) : run ? (
            <a className="btn secondary" href={href({ name: 'workflow', id: wf.id })}>
              <RotateCcw size={15} /> New run
            </a>
          ) : null
        }
      />
      <div className="row wrap" style={{ marginTop: -12, marginBottom: 20 }}>
        <Badge tone="brand">{wf.category}</Badge>
        <Badge tone={risk.tone}>{risk.label}</Badge>
        <Badge icon={Lock}>
          {gates} approval gate{gates === 1 ? '' : 's'}
        </Badge>
        {run && <span className="chip">run {run.id.slice(0, 8)}</span>}
      </div>

      {run && (
        <RunBar
          run={run}
          calls={events.filter((e) => e.type === 'rpc.response').length}
          latencyMs={events.reduce((n, e) => n + (e.type === 'rpc.response' ? (e.latencyMs ?? 0) : 0), 0)}
        />
      )}

      <div className="studio">
        <div className="stack">
          <section className="card">
            <CardHeader icon={ListChecks} title="Agent plan" description={`${wf.steps.length} steps · observe → reason → act`} />
            <WorkflowStepper plan={wf.steps} states={run?.steps} />
          </section>

          <section className="card">
            <CardHeader icon={SlidersHorizontal} title="Parameters" description={run ? 'The inputs this run used.' : 'Adjust before launching.'} />
            <div className="card-body">
              <ParameterForm fields={wf.inputs} values={values} errors={errors} domains={domains} disabled={Boolean(run) || starting} onChange={setValues} />
              {error && (
                <div className="alert error" role="alert" style={{ marginTop: 14 }}>
                  {error}
                </div>
              )}
              {!run && (
                <button className="btn primary" style={{ width: '100%', marginTop: 16 }} onClick={launch} disabled={starting || !canLaunch}>
                  {starting ? <Loader2 size={16} className="spin" /> : <Play size={16} />} {starting ? 'Starting agent…' : 'Launch agent'}
                </button>
              )}
              {!canLaunch && !run && <p className="blocked" style={{ marginTop: 10 }}>{wf.availability.reason ?? `Needs the ${wf.roles.join(' or ')} role`}</p>}
            </div>
          </section>

          {wf.notes.length > 0 && (
            <section className="card">
              <CardHeader icon={Info} title="Good to know" tone="neutral" />
              <div className="card-body">
                <ul className="notes">
                  {wf.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </div>
            </section>
          )}
        </div>

        <div className="stack">
          {pending && !showModal && (
            <div className="alert warn" role="status" style={{ alignItems: 'center' }}>
              <ShieldAlert size={18} />
              <span className="grow">
                <strong>{pending.title}</strong> is waiting for your decision.
              </span>
              <button className="btn primary sm" onClick={() => setHidden(null)}>
                Review & decide
              </button>
            </div>
          )}
          {run?.summary && <RunSummaryCard run={run} />}
          {run ? (
            <section className="card" style={{ overflow: 'hidden' }}>
              <div className="tabs" role="tablist" aria-label="Run detail">
                <button role="tab" aria-selected={tab === 'activity'} onClick={() => setTab('activity')}>
                  <Activity size={15} /> Activity
                </button>
                <button role="tab" aria-selected={tab === 'console'} onClick={() => setTab('console')}>
                  <SquareTerminal size={15} /> Console <span className="n">{events.length}</span>
                </button>
              </div>
              {tab === 'activity' ? (
                <ActivityFeed events={events} plan={wf.steps} pending={pending} onReview={() => setHidden(null)} />
              ) : (
                <TerminalConsole events={events} connected={connected} finished={Boolean(run.finishedAt)} />
              )}
            </section>
          ) : (
            <HowItWorks wf={wf} />
          )}
        </div>
      </div>

      {showModal && pending && runId && <HumanApprovalModal key={pending.id} runId={runId} approval={pending} onHide={() => setHidden(pending.id)} />}
    </>
  );
}
