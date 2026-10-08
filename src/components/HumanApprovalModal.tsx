import { useEffect, useRef, useState } from 'react';
import { Brain, CheckCircle2, ChevronRight, Clock, Code2, FileText, Loader2, PenLine, ShieldAlert, XCircle } from 'lucide-react';
import type { PendingApproval } from '../../common/types';
import { ApiError, api } from '../api';
import { TOOL_RISK } from '../status';
import { FieldInput, initialValues, toPayload, type FieldValues } from './ParameterForm';
import { Badge } from './ui';

function useCountdown(until: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((Date.parse(until) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Human-in-the-loop gate. The server will not execute the tool until this decision arrives; only the
 * declared editable fields can change (and the tool validates them again).
 */
export function HumanApprovalModal({ runId, approval, onHide }: { runId: string; approval: PendingApproval; onHide: () => void }) {
  const [values, setValues] = useState<FieldValues>(() => initialValues(approval.editableFields, approval.args));
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const fields = useRef<HTMLDivElement>(null);
  const left = useCountdown(approval.expiresAt);
  const risk = TOOL_RISK[approval.risk];

  useEffect(() => {
    (fields.current?.querySelector('input, textarea, select') as HTMLElement | null)?.focus();
  }, [approval.id]);

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(decision);
    setError(null);
    setErrors({});
    try {
      await api('POST', `/runs/${runId}/approvals/${approval.id}`, { decision, args: decision === 'approve' ? toPayload(approval.editableFields, values) : undefined, note: note || undefined });
    } catch (e) {
      if (e instanceof ApiError) {
        setErrors(e.fieldErrors);
        setError(e.message);
      } else setError('Could not send the decision');
      setBusy(null);
    }
  };

  const shownArgs = { ...approval.args, ...toPayload(approval.editableFields, values) };

  return (
    <div className="overlay" role="presentation">
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="hitl-title" aria-describedby="hitl-prompt">
        <div className="modal-head">
          <span className="icon-tile lg warn" aria-hidden>
            <ShieldAlert size={22} />
          </span>
          <div className="grow">
            <div className="row wrap" style={{ gap: 8 }}>
              <h2 id="hitl-title">Approval required</h2>
              <Badge tone={risk.tone}>{risk.label}</Badge>
              <span className="chip">{approval.tool}</span>
            </div>
            <p>{approval.title}</p>
          </div>
        </div>

        <div className="modal-body">
          <p id="hitl-prompt" style={{ fontSize: 15, fontWeight: 500 }}>
            {approval.prompt}
          </p>

          {approval.assessment.length > 0 && (
            <div>
              <div className="section-title">
                <Brain size={13} /> Agent assessment
              </div>
              <ul className="evidence">
                {approval.assessment.map((a) => (
                  <li key={a}>
                    <ChevronRight size={14} /> {a}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {approval.details.map((d) => (
            <div key={d.label}>
              <div className="section-title">
                {d.format === 'code' ? <Code2 size={13} /> : <FileText size={13} />} {d.label}
              </div>
              {d.format === 'code' ? <pre className="code-block">{d.content}</pre> : <p className="text-block">{d.content}</p>}
            </div>
          ))}

          {approval.editableFields.length > 0 && (
            <div>
              <div className="section-title">
                <PenLine size={13} /> You can adjust before approving
              </div>
              <div className="form" ref={fields}>
                {approval.editableFields.map((f) => (
                  <FieldInput key={f.key} idPrefix="hitl" field={f} value={values[f.key]} error={errors[f.key]} onChange={(v) => setValues({ ...values, [f.key]: v })} />
                ))}
              </div>
            </div>
          )}

          <details className="args">
            <summary>
              <Code2 size={14} /> MCP call that will be sent
            </summary>
            <pre className="code-block" style={{ marginTop: 8 }}>
              {JSON.stringify({ method: 'tools/call', params: { name: approval.tool, arguments: shownArgs } }, null, 2)}
            </pre>
          </details>

          <div className="field">
            <label htmlFor="hitl-note">Note for the log (optional)</label>
            <input id="hitl-note" className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Confirmed with the invigilator in Lab 3" />
          </div>

          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <span className="expires">
            <Clock size={13} /> Auto-rejects in {left}
          </span>
          <button className="btn ghost sm" onClick={onHide} disabled={busy !== null}>
            View activity
          </button>
          <button className="btn secondary" onClick={() => decide('reject')} disabled={busy !== null}>
            {busy === 'reject' ? <Loader2 size={15} className="spin" /> : <XCircle size={15} />} Reject step
          </button>
          <button className="btn primary" onClick={() => decide('approve')} disabled={busy !== null}>
            {busy === 'approve' ? <Loader2 size={15} className="spin" /> : <CheckCircle2 size={15} />} Approve & execute
          </button>
        </div>
      </div>
    </div>
  );
}
