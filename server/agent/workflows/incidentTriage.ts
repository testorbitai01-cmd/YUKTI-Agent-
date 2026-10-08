/**
 * 🚨 Live proctoring incident triage.
 * observe (live sessions + their logs) → reason (severity score per session) → act (terminate the worst
 * one, gated) — or stop and recommend monitoring when nothing crosses the threshold.
 */
import { z } from 'zod';
import { reasonStep, toolStep, type RunContext, type WorkflowDefinition } from '../types.js';
import { domainField, input, out, plural, v } from './common.js';

interface LiveSession {
  id: string;
  student: { fullName: string; collegeName: string };
  paperName: string;
}
interface EventsOut {
  session: { id: string; status: string; statusLabel: string; answered: string };
  student: { fullName: string };
  totals: { events: number; warnings: number; terminations: number; byType: Record<string, number> };
}
export interface Scored {
  sessionId: string;
  student: string;
  score: number;
  evidence: string[];
}

/** Severity weights: identity/collusion signals outrank attention signals. */
export const SEVERITY_WEIGHTS: Record<string, number> = {
  MULTIPLE_FACES_DETECTED: 3,
  SPEECH_DETECTED: 1.5,
  FACE_NOT_VISIBLE: 1,
  TAB_HIDDEN: 1,
  WINDOW_BLUR: 0.5,
  CAMERA_DISCONNECTED: 1.5,
  MICROPHONE_DISCONNECTED: 1,
};

export function scoreSession(e: EventsOut): Scored {
  let score = 0;
  const evidence: string[] = [];
  for (const [type, n] of Object.entries(e.totals.byType)) {
    const w = SEVERITY_WEIGHTS[type] ?? 0;
    if (!w) continue;
    score += w * n;
    evidence.push(`${type.toLowerCase().replace(/_/g, ' ')} ×${n} (+${w * n})`);
  }
  return { sessionId: e.session.id, student: e.student.fullName, score: Math.round(score * 10) / 10, evidence };
}

const input$ = z.object({
  domainSlug: z.string().trim().optional(),
  sessionId: z.string().trim().max(64).optional(),
  threshold: z.coerce.number().min(1).max(50).default(6),
  maxSessions: z.coerce.number().int().min(1).max(25).default(10),
});

interface Target {
  id: string;
  name: string;
}

const sessionsToInspect = (ctx: RunContext): Target[] => {
  const live = out<{ sessions: LiveSession[] }>(ctx, 'live').sessions;
  const one = input<string | undefined>(ctx, 'sessionId');
  if (one) return [{ id: one, name: live.find((s) => s.id === one)?.student.fullName ?? one }];
  return live.slice(0, input<number>(ctx, 'maxSessions')).map((s) => ({ id: s.id, name: s.student.fullName }));
};

export const incidentTriageWorkflow: WorkflowDefinition = {
  id: 'incident-triage',
  title: 'Live Proctoring Incident Triage',
  category: 'Proctoring Ops',
  goal: 'Scan live sessions for severe proctoring signals (multiple faces, speech, tab switches), rank them, and propose terminating only the session that crosses your threshold.',
  description: 'Reads every live session’s proctoring log, scores severity with transparent weights, and either recommends continued monitoring or asks you to terminate the worst session.',
  risk: 'HIGH',
  estimatedSeconds: 25,
  roles: ['ADMIN'],
  notes: [
    'There is no "warn the candidate" tool: Test Orbit has no admin-to-candidate messaging. Candidates already receive automatic on-screen warnings from the proctoring rules (Settings).',
    'Automatic detections can be wrong; termination is irreversible and always waits for your approval.',
  ],
  inputs: [
    domainField('domainSlug', 'Domain (optional)', false),
    { key: 'sessionId', label: 'Specific session (optional)', type: 'text', placeholder: 'Leave empty to scan live sessions' },
    { key: 'threshold', label: 'Severity threshold', type: 'number', default: 6, min: 1, max: 50, help: 'Multiple faces = 3, camera off / speech = 1.5, tab switch / face not visible = 1, blur = 0.5 per event.' },
    { key: 'maxSessions', label: 'Sessions to scan', type: 'number', default: 10, min: 1, max: 25 },
  ],
  input: input$,
  steps: [
    toolStep({
      kind: 'tool',
      id: 'live',
      title: 'List live sessions',
      description: 'Sessions currently in progress.',
      tool: 'list_active_sessions',
      args: (ctx) => ({ status: 'IN_PROGRESS', domainSlug: input(ctx, 'domainSlug') || undefined, limit: 50 }),
      stopIf: (o, ctx) => (!input(ctx, 'sessionId') && !(o.sessions as unknown[]).length ? 'No assessment is in progress right now.' : null),
    }),
    toolStep<Target>({
      kind: 'tool',
      id: 'logs',
      title: 'Read proctoring logs',
      description: 'One log per session.',
      tool: 'get_proctoring_events',
      forEach: { items: sessionsToInspect, key: (t) => t.id, label: (t) => t.name },
      args: (_ctx, t) => ({ sessionId: t!.id }),
    }),
    reasonStep({
      id: 'triage',
      title: 'Score severity',
      description: 'Rank sessions by weighted proctoring signals.',
      think: (ctx) => {
        const scored = (out<(EventsOut | null)[]>(ctx, 'logs') ?? []).filter((e): e is EventsOut => e !== null).map(scoreSession).sort((a, b) => b.score - a.score);
        const threshold = input<number>(ctx, 'threshold');
        const thoughts = scored.slice(0, 5).map((s) => `${s.student}: severity ${s.score}${s.evidence.length ? ` — ${s.evidence.join(', ')}` : ' (clean)'}`);
        const worst = scored[0];
        if (!worst || worst.score < threshold) {
          return { thoughts: [...thoughts, `No session reaches the threshold of ${threshold}.`], vars: { scored }, stop: `No incident: ${plural(scored.length, 'session')} scanned, highest severity ${worst?.score ?? 0} < ${threshold}. Keep monitoring.` };
        }
        return { thoughts: [...thoughts, `${worst.student} crosses the threshold (${worst.score} ≥ ${threshold}).`], vars: { scored, target: worst } };
      },
    }),
    toolStep({
      kind: 'tool',
      id: 'terminate',
      title: 'Terminate session',
      description: 'Irreversible: saved answers are scored, re-entry is cancelled.',
      tool: 'terminate_session',
      args: (ctx) => {
        const t = v<Scored>(ctx, 'target');
        return { sessionId: t.sessionId, reason: `Proctoring incident confirmed by invigilator: ${t.evidence.join(', ')} (YUKTI severity ${t.score})` };
      },
      approval: {
        prompt: (ctx) => `Terminate ${v<Scored>(ctx, 'target').student}'s assessment permanently? Reject to keep monitoring instead.`,
        assessment: (ctx) => {
          const t = v<Scored>(ctx, 'target');
          return [`Severity ${t.score} (threshold ${input(ctx, 'threshold')})`, ...t.evidence, 'Detections can be wrong — confirm with the invigilator in the room before approving.'];
        },
        editable: [{ key: 'reason', label: 'Termination reason (shown on the record)', type: 'textarea', required: true }],
      },
    }),
  ],
  summarize: (ctx, o) => {
    const scored = (ctx.vars.scored as Scored[] | undefined) ?? [];
    const t = ctx.vars.target as Scored | undefined;
    const done = ctx.outputs.terminate as { status: string } | null | undefined;
    if (done && t) {
      return {
        headline: `${t.student}'s session was terminated`,
        highlights: [
          { label: 'Severity', value: String(t.score), tone: 'danger' },
          { label: 'Sessions scanned', value: String(scored.length) },
        ],
        nextActions: ['Record the invigilator’s report.', 'The result is in Admin → Assessments (saved answers were scored).'],
      };
    }
    return {
      headline: o.status === 'rejected' ? `Termination declined — ${t?.student} keeps going` : (o.stopReason ?? 'Triage finished'),
      highlights: [
        { label: 'Sessions scanned', value: String(scored.length) },
        { label: 'Highest severity', value: String(scored[0]?.score ?? 0), tone: scored[0] && scored[0].score >= (ctx.inputs.threshold as number) ? 'warn' : 'success' },
      ],
      nextActions: ['Re-run in a few minutes during the drive.', 'Tune per-event rules in Test Orbit Settings → Proctoring if alerts are noisy.'],
    };
  },
};
