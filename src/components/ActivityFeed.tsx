/**
 * Human-readable agent timeline built from the run's event stream:
 * what the agent observed, how it reasoned, what it did, and where it is waiting for you.
 * (The raw JSON-RPC exchange is in the Console tab.)
 */
import { useEffect, useMemo, useRef } from 'react';
import { AlertTriangle, Brain, CheckCircle2, CircleDot, Eye, Flag, Rocket, ShieldAlert, SkipForward, UserCheck, UserX, XCircle, Zap, type LucideIcon } from 'lucide-react';
import type { PendingApproval, RunEvent, WorkflowStepSummary } from '../../common/types';
import { fmtTime } from '../status';

interface Item {
  seq: number;
  at: string;
  icon: LucideIcon;
  tone: 'observe' | 'reason' | 'success' | 'warn' | 'danger' | '';
  kind: string;
  message: string;
  thought?: boolean;
  chips?: string[];
  approvalId?: string;
}

/** Drop the console's status glyph (✓ ✔ ⤼ ▶ ⚠️ …) — the timeline shows an icon instead. */
const strip = (m: string) => m.replace(/^(?:[✓✗✔✖⤼▶]|⚠️)\s*/u, '');

function toItem(e: RunEvent, steps: Map<string, WorkflowStepSummary>): Item | null {
  const step = e.stepId ? steps.get(e.stepId) : undefined;
  const base = { seq: e.seq, at: e.at };
  switch (e.type) {
    case 'run.started':
      return { ...base, icon: Rocket, tone: 'observe', kind: 'Run', message: e.message };
    case 'step.started':
      return { ...base, icon: CircleDot, tone: '', kind: 'Step', message: step ? step.title : strip(e.message) };
    case 'agent.thought':
      return e.level === 'warn'
        ? { ...base, icon: AlertTriangle, tone: 'warn', kind: 'Reasoning', message: e.message, thought: true }
        : e.level === 'success'
          ? { ...base, icon: CheckCircle2, tone: 'success', kind: 'Result', message: e.message }
          : { ...base, icon: Brain, tone: 'reason', kind: 'Reasoning', message: e.message, thought: true };
    case 'rpc.response': {
      const m = /^[✓✗]\s+(\S+?)(?:\s*·\s*|:\s*)(.*)$/su.exec(e.message);
      const tool = m?.[1] ?? step?.tool ?? 'tool';
      const chips = [tool, ...(e.latencyMs !== undefined ? [`${e.latencyMs} ms`] : []), ...(e.httpStatus ? [`HTTP ${e.httpStatus}`] : [])];
      if (e.level === 'error') return { ...base, icon: XCircle, tone: 'danger', kind: 'Tool error', message: m?.[2] ?? e.message, chips };
      const write = step && step.risk !== 'read';
      return { ...base, icon: write ? Zap : Eye, tone: write ? 'success' : 'observe', kind: write ? 'Action' : 'Observation', message: m?.[2] ?? e.message, chips };
    }
    case 'approval.requested':
      return { ...base, icon: ShieldAlert, tone: 'warn', kind: 'Approval needed', message: strip(e.message), approvalId: (e.data as { approvalId?: string } | undefined)?.approvalId };
    case 'approval.decided': {
      const approved = e.level === 'success';
      return { ...base, icon: approved ? UserCheck : UserX, tone: approved ? 'success' : 'warn', kind: 'Your decision', message: e.message };
    }
    case 'step.finished':
      if (e.level === 'success') return null; // the step's results are already in the timeline
      return e.level === 'error'
        ? { ...base, icon: XCircle, tone: 'danger', kind: 'Step failed', message: strip(e.message) }
        : { ...base, icon: SkipForward, tone: '', kind: 'Step', message: strip(e.message) };
    case 'run.finished':
      return { ...base, icon: Flag, tone: e.level === 'error' ? 'danger' : e.level === 'success' ? 'success' : 'warn', kind: 'Run', message: e.message };
    default:
      return null;
  }
}

export function ActivityFeed({ events, plan, pending, onReview }: { events: RunEvent[]; plan: WorkflowStepSummary[]; pending: PendingApproval | null; onReview: () => void }) {
  const steps = useMemo(() => new Map(plan.map((s) => [s.id, s])), [plan]);
  const items = useMemo(() => events.map((e) => toItem(e, steps)).filter((i): i is Item => i !== null), [events, steps]);
  const box = useRef<HTMLOListElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [items.length]);

  if (!items.length) return <div className="empty pulse">The agent is starting…</div>;
  return (
    <ol
      className="timeline"
      ref={box}
      aria-live="polite"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
    >
      {items.map((it) => (
        <li key={it.seq} className="tl">
          <span className={`tl-icon ${it.tone}`} aria-hidden>
            <it.icon size={15} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="tl-head">
              <span className="tl-kind">{it.kind}</span>
              <span className="tl-time">{fmtTime(it.at)}</span>
            </div>
            <div className={`tl-msg${it.thought ? ' thought' : ''}`}>{it.message}</div>
            {it.chips && (
              <div className="tl-chips">
                {it.chips.map((c) => (
                  <span key={c} className="chip">
                    {c}
                  </span>
                ))}
              </div>
            )}
            {it.approvalId && pending?.id === it.approvalId && (
              <div className="tl-approval">
                <span className="grow" style={{ fontSize: 13 }}>
                  <strong>{pending.title}</strong> is paused until you decide.
                </span>
                <button className="btn primary sm" onClick={onReview}>
                  <ShieldAlert size={14} /> Review & decide
                </button>
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
