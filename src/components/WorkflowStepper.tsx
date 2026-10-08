import { Check, Hourglass, Loader2, Lock, Repeat, SkipForward, X } from 'lucide-react';
import type { StepState, StepStatus, WorkflowStepSummary } from '../../common/types';
import { SERVICE, STEP_KIND, fmtDuration, stepKind } from '../status';
import { Badge } from './ui';

const STATUS_ICON: Partial<Record<StepStatus, JSX.Element>> = {
  running: <Loader2 size={15} className="spin" />,
  awaiting_approval: <Hourglass size={15} className="pulse" />,
  succeeded: <Check size={15} />,
  failed: <X size={15} />,
  rejected: <X size={15} />,
  skipped: <SkipForward size={14} />,
};
const STATUS_LABEL: Record<StepStatus, string> = { pending: 'Pending', running: 'Running', awaiting_approval: 'Waiting for approval', succeeded: 'Done', failed: 'Failed', rejected: 'Rejected', skipped: 'Skipped' };

/** The agent's plan: every step with what it does (observe / reason / act / gate) and its live state. */
export function WorkflowStepper({ plan, states }: { plan: WorkflowStepSummary[]; states?: StepState[] }) {
  return (
    <ol className="steps" aria-label="Agent plan">
      {plan.map((p, i) => {
        const s = states?.[i];
        const status: StepStatus = s?.status ?? 'pending';
        const current = status === 'running' || status === 'awaiting_approval';
        const kind = stepKind(p);
        const K = STEP_KIND[kind];
        return (
          <li key={p.id} className={`step ${status}${current ? ' current' : ''}`} aria-current={current ? 'step' : undefined}>
            <span className={`step-node${status === 'pending' ? ` pipe-node ${kind}` : ''}`} aria-hidden>
              {STATUS_ICON[status] ?? <K.icon size={14} />}
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="step-title">
                <span>
                  {i + 1}. {p.title}
                </span>
                {p.requiresApproval && (
                  <Badge tone="warn" icon={Lock}>
                    Approval
                  </Badge>
                )}
                {p.forEach && (
                  <Badge icon={Repeat} title="Runs once per item">
                    per item
                  </Badge>
                )}
                {p.conditional && <Badge>if needed</Badge>}
              </div>
              <div className="step-sub">
                <span>{K.label}</span>
                {p.tool && (
                  <>
                    <span>·</span>
                    <code>{p.tool}</code>
                  </>
                )}
                {p.service && (
                  <>
                    <span>·</span>
                    <span>{SERVICE[p.service].label}</span>
                  </>
                )}
                {s?.latencyMs !== undefined && status !== 'pending' && (
                  <>
                    <span>·</span>
                    <span>{fmtDuration(s.latencyMs)}</span>
                  </>
                )}
                <span className="sr-only">— {STATUS_LABEL[status]}</span>
              </div>
              {(s?.error || s?.note) && <div className={`step-note${s.error ? ' err' : ''}`}>{s.error ?? s.note}</div>}
              {s?.items && s.items.length > 0 && (
                <ul className="step-items">
                  {s.items.map((it) => (
                    <li key={it.key}>
                      {STATUS_ICON[it.status] ?? <span className="dot" />} {it.label}
                      {it.error ? ` — ${it.error}` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
