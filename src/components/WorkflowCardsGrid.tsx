import { useMemo, useState } from 'react';
import { Activity, CheckCircle2, LayoutGrid, Search, SearchX, ShieldAlert, Workflow } from 'lucide-react';
import type { OperatorView, RunView, WorkflowSummary } from '../../common/types';
import { CATEGORIES } from '../data/workflowsData';
import { STEP_KIND } from '../status';
import { EmptyState, PageHeader, StatCard } from './ui';
import { WorkflowCard } from './WorkflowCard';

interface Props {
  workflows: WorkflowSummary[] | null;
  error: string | null;
  operator: OperatorView;
  runs: RunView[];
}

export function WorkflowCardsGrid({ workflows, error, operator, runs }: Props) {
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (workflows ?? []).filter(
      (w) => (!category || w.category === category) && (!q || `${w.title} ${w.goal} ${w.category} ${w.steps.map((s) => s.tool ?? '').join(' ')}`.toLowerCase().includes(q)),
    );
  }, [workflows, category, query]);

  const today = new Date().toDateString();
  const active = runs.filter((r) => !r.finishedAt).length;
  const waiting = runs.filter((r) => r.pendingApproval).length;
  const doneToday = runs.filter((r) => r.status === 'completed' && new Date(r.createdAt).toDateString() === today).length;
  const ready = workflows?.filter((w) => w.availability.ready).length ?? 0;

  return (
    <>
      <PageHeader
        title="Agent workflows"
        description="Pre-planned recruitment-drive operations. The agent observes through live Test Orbit tools, reasons over what it finds, and waits for your approval before any action that affects candidates."
      />

      <div className="stats">
        <StatCard label="Workflows" value={workflows?.length ?? '—'} hint={`${ready} ready to launch`} icon={Workflow} tone="brand" />
        <StatCard label="Runs in progress" value={active} hint="Across your session" icon={Activity} tone={active ? 'brand' : 'neutral'} />
        <StatCard label="Awaiting approval" value={waiting} hint={waiting ? 'Open Approvals to decide' : 'Nothing waiting'} icon={ShieldAlert} tone={waiting ? 'warn' : 'neutral'} />
        <StatCard label="Completed today" value={doneToday} hint="Successful runs" icon={CheckCircle2} tone="success" />
      </div>

      <div className="toolbar">
        <div className="seg" role="toolbar" aria-label="Filter by category">
          <button aria-pressed={category === null} onClick={() => setCategory(null)}>
            <LayoutGrid size={13} /> All <span className="n">{workflows?.length ?? 0}</span>
          </button>
          {CATEGORIES.map((c) => (
            <button key={c} aria-pressed={category === c} onClick={() => setCategory(category === c ? null : c)}>
              {c} <span className="n">{workflows?.filter((w) => w.category === c).length ?? 0}</span>
            </button>
          ))}
        </div>
        <label className="search">
          <span className="sr-only">Search workflows</span>
          <Search size={15} />
          <input className="input" placeholder="Search workflows or tools" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>

      <div className="legend" style={{ marginBottom: 14 }} aria-label="Pipeline legend">
        {(['observe', 'reason', 'act', 'gate'] as const).map((k) => {
          const { icon: Icon, label } = STEP_KIND[k];
          return (
            <span key={k}>
              <span className={`pipe-node ${k}`} style={{ width: 20, height: 20, borderRadius: 6 }}>
                <Icon size={11} />
              </span>
              {label}
            </span>
          );
        })}
      </div>

      {error && (
        <div className="alert error" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}
      {!workflows && !error && <div className="center pulse">Loading workflows…</div>}
      {workflows && !visible.length && (
        <div className="card">
          <EmptyState icon={SearchX} title="No workflow matches" description="Try another category or search term." />
        </div>
      )}

      <div className="grid">
        {visible.map((wf) => (
          <WorkflowCard key={wf.id} wf={wf} operator={operator} />
        ))}
      </div>
    </>
  );
}
