import { useState } from 'react';
import { AlertTriangle, ArrowRight, Check, CheckCircle2, Copy, Download, Gauge, Timer, Wrench, XCircle } from 'lucide-react';
import type { RunView } from '../../common/types';
import { fmtDuration } from '../status';
import { CardHeader } from './ui';

function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn ghost sm"
      style={{ height: 26, padding: '0 6px' }}
      aria-label={`Copy ${value}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

export function RunSummaryCard({ run }: { run: RunView }) {
  const s = run.summary;
  if (!s) return null;
  const failed = run.status === 'failed';
  const head = failed
    ? { icon: XCircle, tone: 'danger' as const, label: 'Run failed' }
    : s.outcome === 'success'
      ? { icon: CheckCircle2, tone: 'success' as const, label: 'Completed' }
      : s.outcome === 'partial'
        ? { icon: AlertTriangle, tone: 'warn' as const, label: 'Completed with exceptions' }
        : { icon: AlertTriangle, tone: 'warn' as const, label: 'Stopped' };
  const elapsed = run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.createdAt) : 0;

  return (
    <section className="card" aria-label="Run summary">
      <CardHeader icon={head.icon} tone={head.tone} title={s.headline} description={head.label} />
      <div className="card-body" style={{ display: 'grid', gap: 16 }}>
        {run.error && <div className="alert error">{run.error}</div>}
        <div className="kpis">
          {s.highlights.map((h) => (
            <div key={h.label} className={`kpi ${h.tone ?? ''} ${h.copyable && /^[A-Z0-9]{6,12}$/.test(h.value) ? 'code' : ''}`}>
              <div className="k">{h.label}</div>
              <div className="v">
                <span style={{ minWidth: 0 }}>{h.value}</span>
                {h.copyable && <CopyButton value={h.value} />}
              </div>
            </div>
          ))}
          <div className="kpi">
            <div className="k">
              <Wrench size={11} /> Tools executed
            </div>
            <div className="v">{s.toolsExecuted}</div>
          </div>
          <div className="kpi">
            <div className="k">
              <Gauge size={11} /> MCP latency
            </div>
            <div className="v">{fmtDuration(s.totalLatencyMs)}</div>
          </div>
          <div className="kpi">
            <div className="k">
              <Timer size={11} /> Total time
            </div>
            <div className="v">{fmtDuration(elapsed)}</div>
          </div>
        </div>
        {s.artifacts.length > 0 && (
          <div className="row wrap">
            {s.artifacts.map((a) => (
              <a key={a.id} className="btn secondary sm" href={`/api/runs/${run.id}/artifacts/${a.id}`} download={a.name}>
                <Download size={14} /> {a.name} · {(a.bytes / 1024).toFixed(1)} KB
              </a>
            ))}
          </div>
        )}
        {s.nextActions.length > 0 && (
          <div>
            <div className="section-title">Recommended next actions</div>
            <ul className="next">
              {s.nextActions.map((n) => (
                <li key={n}>
                  <ArrowRight size={14} /> {n}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
