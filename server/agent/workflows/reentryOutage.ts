/**
 * ⚡ Candidate outage & re-entry approval.
 * observe (who, which request, what happened) → reason (routine outage or policy case?) → act (approve, gated).
 */
import { z } from 'zod';
import { reasonStep, toolStep, type RunContext, type WorkflowDefinition } from '../types.js';
import { candidateField, fmtDuration, input, out, pickOneStudent, plural, v, type StudentRef } from './common.js';

interface ReentryItem {
  id: string;
  trigger: 'NETWORK_INTERRUPTION' | 'POLICY_TERMINATION';
  createdAt: string;
  student: StudentRef;
  session: { id: string; status: string; statusLabel: string; remainingMs: number; eventCount: number; lastAnswerSavedAt: string | null };
}
interface EventsOut {
  session: { status: string; statusLabel: string; remainingMs: number; resumeCount: number; terminationReason: string | null; answered: string; lastHeartbeatAt: string | null };
  totals: { events: number; warnings: number; terminations: number; byType: Record<string, number> };
  events: { type: string; label: string; action: string; createdAt: string }[];
}
interface Assessment {
  verdict: 'routine' | 'review';
  lines: string[];
}

const MIN_RESUME_MS = 30_000; // Test Orbit refuses approvals that leave less than this

/** Turn the evidence into a recommendation the approver can check at a glance. */
export function assessReentry(req: ReentryItem, ev: EventsOut, extraMinutes: number): Assessment {
  const lines: string[] = [];
  const policy = req.trigger === 'POLICY_TERMINATION';
  lines.push(policy ? `Trigger: POLICY TERMINATION — ${ev.session.terminationReason ?? 'proctoring limit exceeded'}` : 'Trigger: connection lost (no heartbeat), not a proctoring violation');
  lines.push(`Session ${ev.session.statusLabel.toLowerCase()}; ${ev.session.answered} answered; ${fmtDuration(ev.session.remainingMs)} held`);
  const top = Object.entries(ev.totals.byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([t, n]) => `${t.toLowerCase().replace(/_/g, ' ')} ×${n}`);
  lines.push(`Proctoring: ${plural(ev.totals.warnings, 'warning')}${top.length ? ` (${top.join(', ')})` : ', no events'}`);
  if (ev.session.resumeCount > 0) lines.push(`Already resumed ${plural(ev.session.resumeCount, 'time')} in this attempt`);
  const after = ev.session.remainingMs + extraMinutes * 60_000;
  if (after < MIN_RESUME_MS) lines.push(`⚠ Only ${fmtDuration(after)} would remain — Test Orbit will refuse; add a positive time adjustment`);
  const verdict = !policy && ev.totals.warnings <= 1 && ev.session.resumeCount < 2 ? 'routine' : 'review';
  lines.push(verdict === 'routine' ? 'Assessment: consistent with a genuine outage → approving is reasonable' : 'Assessment: needs judgement — confirm with the invigilator before approving');
  return { verdict, lines };
}

const input$ = z.object({
  candidate: z.string().trim().min(2).max(120),
  extraMinutes: z.coerce.number().int().min(-60).max(60).default(5),
  reason: z.string().trim().min(5).max(1000).default('Verified power / network outage at the exam centre'),
});

export const reentryOutageWorkflow: WorkflowDefinition = {
  id: 'reentry-outage',
  title: 'Candidate Outage & Re-entry Approval',
  category: 'Proctoring Ops',
  goal: 'Triage a disconnected candidate, check their proctoring log, and approve re-entry with a time adjustment and a real one-time resume code.',
  description: 'Finds the candidate and their pending re-entry request, reads the proctoring events, judges whether it looks like a genuine outage, then asks you to approve.',
  risk: 'MEDIUM',
  estimatedSeconds: 15,
  roles: ['ADMIN'],
  notes: ['The resume code is issued by Test Orbit itself (8 characters, single use, shown once) — the same code the admin console would give.'],
  inputs: [
    candidateField,
    { key: 'extraMinutes', label: 'Time adjustment (minutes)', type: 'number', default: 5, min: -60, max: 60, help: 'Added to the remaining time held for the student.' },
    { key: 'reason', label: 'Decision reason (audit log)', type: 'textarea', default: 'Verified power / network outage at the exam centre', required: true },
  ],
  input: input$,
  steps: [
    toolStep({
      kind: 'tool',
      id: 'find',
      title: 'Find candidate',
      description: 'Search students by registration number, name or mobile.',
      tool: 'search_students',
      args: (ctx) => ({ query: input(ctx, 'candidate'), limit: 10 }),
    }),
    reasonStep({
      id: 'identify',
      title: 'Identify exactly one candidate',
      description: 'Refuse to guess when the search is ambiguous.',
      think: (ctx) => pickOneStudent(out<{ students: StudentRef[] }>(ctx, 'find').students, input(ctx, 'candidate')),
    }),
    toolStep({
      kind: 'tool',
      id: 'requests',
      title: 'Find pending re-entry request',
      description: 'Pending requests are opened automatically when a session is interrupted or flagged.',
      tool: 'list_reentry_requests',
      args: (ctx) => ({ search: input(ctx, 'candidate'), status: 'PENDING', limit: 20 }),
    }),
    reasonStep({
      id: 'match',
      title: 'Match request to candidate',
      description: 'Pick the pending request that belongs to the identified candidate.',
      think: (ctx) => {
        const student = v<StudentRef>(ctx, 'student');
        const req = out<{ requests: ReentryItem[] }>(ctx, 'requests').requests.find((r) => r.student.id === student.id);
        if (!req) {
          return {
            thoughts: [`${student.fullName} has no pending re-entry request.`],
            stop: `${student.fullName} has no pending re-entry request — their session is probably still running, already resumed, or finished. Check Admin → Re-entry.`,
          };
        }
        return {
          thoughts: [`Pending request from ${new Date(req.createdAt).toLocaleTimeString('en-IN')} (${req.trigger === 'NETWORK_INTERRUPTION' ? 'connection lost' : 'policy termination'}), session ${req.session.statusLabel.toLowerCase()}.`],
          vars: { request: req },
        };
      },
    }),
    toolStep({
      kind: 'tool',
      id: 'events',
      title: 'Inspect proctoring log',
      description: 'Read the session’s events and warnings before deciding.',
      tool: 'get_proctoring_events',
      args: (ctx) => ({ sessionId: v<ReentryItem>(ctx, 'request').session.id }),
    }),
    reasonStep({
      id: 'assess',
      title: 'Assess the interruption',
      description: 'Genuine outage or a case that needs judgement?',
      think: (ctx) => {
        const a = assessReentry(v<ReentryItem>(ctx, 'request'), out<EventsOut>(ctx, 'events'), input<number>(ctx, 'extraMinutes'));
        return { thoughts: a.lines, vars: { assessment: a } };
      },
    }),
    toolStep({
      kind: 'tool',
      id: 'approve',
      title: 'Approve re-entry',
      description: 'Test Orbit issues a single-use resume code and applies the time adjustment.',
      tool: 'approve_reentry_request',
      args: (ctx) => ({ reentryId: v<ReentryItem>(ctx, 'request').id, timeAdjustmentMinutes: input(ctx, 'extraMinutes'), decisionReason: input(ctx, 'reason') }),
      approval: {
        prompt: (ctx) => {
          const s = v<StudentRef>(ctx, 'student');
          return `Approve re-entry for ${s.fullName} and issue a one-time resume code?`;
        },
        assessment: (ctx) => v<Assessment>(ctx, 'assessment').lines,
        editable: [
          { key: 'timeAdjustmentMinutes', label: 'Time adjustment (minutes)', type: 'number', min: -60, max: 60, required: true },
          { key: 'decisionReason', label: 'Decision reason (audit log)', type: 'textarea', required: true },
        ],
      },
    }),
  ],
  summarize: (ctx: RunContext, o) => {
    const student = ctx.vars.student as StudentRef | undefined;
    const approved = ctx.outputs.approve as { resumeCode: string; resumeCodeExpiresAt: string; timeAdjustmentMinutes: number } | null | undefined;
    if (approved) {
      return {
        headline: `Re-entry approved for ${student?.fullName}`,
        highlights: [
          { label: 'Resume code', value: approved.resumeCode, tone: 'success', copyable: true },
          { label: 'Valid until', value: new Date(approved.resumeCodeExpiresAt).toLocaleString('en-IN') },
          { label: 'Time adjustment', value: `${approved.timeAdjustmentMinutes >= 0 ? '+' : ''}${approved.timeAdjustmentMinutes} min` },
          { label: 'Candidate', value: student?.fullName ?? '—' },
        ],
        nextActions: [
          'Give the code to the candidate in person or by phone — it is shown only now and works once.',
          'They enter their registration number and the code on the session-status page (any computer).',
          'If it expires or is mistyped 5 times, issue a new code from Admin → Re-entry.',
        ],
      };
    }
    if (o.status === 'rejected') return { headline: 'Approval declined — nothing was changed', highlights: student ? [{ label: 'Candidate', value: student.fullName }] : [], nextActions: ['The request stays pending in Admin → Re-entry for a later decision.'] };
    return { headline: o.stopReason ?? 'Run ended before approval', highlights: [], nextActions: ['Check the candidate in Admin → Re-entry or Students.'] };
  },
};
