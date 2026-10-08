import { ArrowRight, Clock, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { RunView } from '../../common/types';
import { href } from '../router';
import { TOOL_RISK, fmtAgo } from '../status';
import { Badge, EmptyState, PageHeader } from './ui';

export function ApprovalsPage({ runs }: { runs: RunView[] }) {
  const pending = runs.filter((r) => r.pendingApproval).sort((a, b) => a.pendingApproval!.requestedAt.localeCompare(b.pendingApproval!.requestedAt));

  return (
    <>
      <PageHeader title="Approvals" description="Gated actions waiting for your decision. Nothing that affects candidates runs until you approve it; unanswered requests auto-reject after 30 minutes." />
      {pending.length === 0 ? (
        <div className="card">
          <EmptyState icon={ShieldCheck} title="Nothing is waiting for you" description="When a workflow reaches a high-risk step, it pauses here until you approve, edit or reject it." />
        </div>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          {pending.map((r) => {
            const a = r.pendingApproval!;
            const risk = TOOL_RISK[a.risk];
            const minsLeft = Math.max(0, Math.round((Date.parse(a.expiresAt) - Date.now()) / 60_000));
            return (
              <div key={a.id} className="card" style={{ padding: 18, display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <span className="icon-tile lg warn" aria-hidden>
                  <ShieldAlert size={20} />
                </span>
                <div className="grow">
                  <div className="row wrap" style={{ gap: 8 }}>
                    <strong style={{ fontSize: 15 }}>{a.title}</strong>
                    <Badge tone={risk.tone}>{risk.label}</Badge>
                    <span className="chip">{a.tool}</span>
                  </div>
                  <p className="muted" style={{ marginTop: 4 }}>{a.prompt}</p>
                  <div className="wf-meta" style={{ marginTop: 8 }}>
                    <span>{r.workflowTitle}</span>
                    <span>·</span>
                    <span>
                      <Clock size={12} /> requested {fmtAgo(a.requestedAt)}
                    </span>
                    <span>·</span>
                    <span style={{ color: minsLeft < 5 ? 'var(--danger)' : undefined }}>auto-rejects in {minsLeft} min</span>
                  </div>
                </div>
                <a className="btn primary sm" href={href({ name: 'run', id: r.id })}>
                  Review & decide <ArrowRight size={14} />
                </a>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
