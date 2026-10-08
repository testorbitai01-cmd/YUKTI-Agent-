import { Fragment } from 'react';
import { AlertTriangle, Clock, Rocket, Users } from 'lucide-react';
import type { OperatorView, WorkflowSummary } from '../../common/types';
import { fmtEstimate, workflowIcon } from '../data/workflowsData';
import { href } from '../router';
import { RISK, STEP_KIND, stepKind } from '../status';
import { Badge } from './ui';

/** The plan as a compact pipeline: one node per step, coloured by what the agent does there. */
export function Pipeline({ steps }: { steps: WorkflowSummary['steps'] }) {
  return (
    <div className="pipeline" role="list" aria-label="Agent pipeline">
      {steps.map((s, i) => {
        const kind = stepKind(s);
        const { icon: Icon, label } = STEP_KIND[kind];
        return (
          <Fragment key={s.id}>
            {i > 0 && <span className="pipe-link" aria-hidden />}
            <span role="listitem" className={`pipe-node ${kind}`} title={`${i + 1}. ${s.title} — ${label}${s.tool ? ` (${s.tool})` : ''}${s.forEach ? ', once per item' : ''}${s.conditional ? ', only if needed' : ''}`}>
              <Icon size={14} />
              <span className="sr-only">
                {s.title}: {label}
              </span>
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

export function WorkflowCard({ wf, operator }: { wf: WorkflowSummary; operator: OperatorView }) {
  const Icon = workflowIcon(wf.id);
  const tools = wf.steps.filter((s) => s.kind === 'tool').length;
  const gates = wf.steps.filter((s) => s.requiresApproval).length;
  const roleOk = wf.roles.includes(operator.role);
  const blocked = !wf.availability.ready ? wf.availability.reason : !roleOk ? `Needs the ${wf.roles.join(' or ')} role` : null;
  const risk = RISK[wf.risk];

  return (
    <article className="card wf" aria-labelledby={`wf-${wf.id}`}>
      <div className="wf-head">
        <span className="icon-tile lg brand" aria-hidden>
          <Icon size={20} />
        </span>
        <div style={{ minWidth: 0 }}>
          <h3 id={`wf-${wf.id}`}>{wf.title}</h3>
          <div className="row wrap" style={{ marginTop: 6, gap: 6 }}>
            <Badge tone="brand">{wf.category}</Badge>
            <Badge tone={risk.tone}>{risk.label}</Badge>
          </div>
        </div>
      </div>
      <p className="goal">{wf.goal}</p>
      <div>
        <Pipeline steps={wf.steps} />
        <div className="wf-meta" style={{ marginTop: 8 }}>
          <span>{wf.steps.length} steps</span>
          <span>·</span>
          <span>{tools} MCP tools</span>
          <span>·</span>
          <span>
            {gates} approval gate{gates === 1 ? '' : 's'}
          </span>
        </div>
      </div>
      <div className="wf-foot">
        {blocked ? (
          <span className="blocked">
            <AlertTriangle size={14} /> {blocked}
          </span>
        ) : (
          <div className="wf-meta">
            <span title="Typical time, excluding approvals">
              <Clock size={13} /> {fmtEstimate(wf.estimatedSeconds)}
            </span>
            <span>
              <Users size={13} /> {wf.roles.map((r) => (r === 'ADMIN' ? 'Admin' : 'Reviewer')).join(' · ')}
            </span>
          </div>
        )}
        {blocked ? (
          <button className="btn primary sm" disabled>
            <Rocket size={14} /> Launch
          </button>
        ) : (
          <a className="btn primary sm" href={href({ name: 'workflow', id: wf.id })}>
            <Rocket size={14} /> Launch agent
          </a>
        )}
      </div>
    </article>
  );
}
