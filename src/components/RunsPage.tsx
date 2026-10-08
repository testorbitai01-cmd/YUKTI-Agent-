import { useState } from 'react';
import { History } from 'lucide-react';
import type { RunStatus, RunView } from '../../common/types';
import { workflowIcon } from '../data/workflowsData';
import { href, navigate } from '../router';
import { RUN_STATUS, fmtAgo, fmtDuration } from '../status';
import { EmptyState, PageHeader, StatusBadge } from './ui';

const FILTERS: { key: string; label: string; match: (s: RunStatus) => boolean }[] = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'live', label: 'In progress', match: (s) => s === 'running' || s === 'awaiting_approval' },
  { key: 'completed', label: 'Completed', match: (s) => s === 'completed' },
  { key: 'stopped', label: 'Failed / stopped', match: (s) => s === 'failed' || s === 'cancelled' || s === 'rejected' },
];

export function RunsPage({ runs }: { runs: RunView[] }) {
  const [filter, setFilter] = useState('all');
  const f = FILTERS.find((x) => x.key === filter)!;
  const shown = runs.filter((r) => f.match(r.status));

  return (
    <>
      <PageHeader title="Runs" description="Every workflow run you started in this session, with its outcome, tool calls and MCP latency. Runs are kept in memory and end when YUKTI restarts." />
      <div className="toolbar">
        <div className="seg" role="toolbar" aria-label="Filter runs">
          {FILTERS.map((x) => (
            <button key={x.key} aria-pressed={filter === x.key} onClick={() => setFilter(x.key)}>
              {x.label} <span className="n">{runs.filter((r) => x.match(r.status)).length}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="card">
        {shown.length === 0 ? (
          <EmptyState icon={History} title="No runs yet" description="Launch a workflow and it will appear here." action={<a className="btn secondary sm" href={href({ name: 'workflows' })}>Browse workflows</a>} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>Status</th>
                  <th>Outcome</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th>Tools</th>
                  <th>MCP latency</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const Icon = workflowIcon(r.workflowId);
                  const go = () => navigate({ name: 'run', id: r.id });
                  return (
                    <tr key={r.id} onClick={go} onKeyDown={(e) => e.key === 'Enter' && go()} tabIndex={0}>
                      <td>
                        <div className="row">
                          <span className="icon-tile brand" style={{ width: 30, height: 30 }} aria-hidden>
                            <Icon size={15} />
                          </span>
                          <strong style={{ fontWeight: 600 }}>{r.workflowTitle}</strong>
                        </div>
                      </td>
                      <td>
                        <StatusBadge meta={RUN_STATUS[r.status]} running={r.status === 'running'} />
                      </td>
                      <td className="muted" style={{ maxWidth: 320 }}>
                        {r.summary?.headline ?? r.pendingApproval?.title ?? `${r.progress}% complete`}
                      </td>
                      <td className="subtle">{fmtAgo(r.createdAt)}</td>
                      <td className="subtle">{fmtDuration((r.finishedAt ? Date.parse(r.finishedAt) : Date.now()) - Date.parse(r.createdAt))}</td>
                      <td>{r.summary?.toolsExecuted ?? '—'}</td>
                      <td className="subtle">{r.summary ? fmtDuration(r.summary.totalLatencyMs) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
