/**
 * 📊 Coding evaluation queue & score finalisation.
 * MCQs are auto-scored by Test Orbit at submission. Coding answers need a human: the agent prepares each
 * answer for review, the reviewer enters marks at the approval gate (one gate per answer), then the agent
 * verifies the recomputed total and places it in the domain's distribution.
 */
import { z } from 'zod';
import { reasonStep, toolStep, type WorkflowDefinition } from '../types.js';
import { domainField, input, out, plural, v } from './common.js';

interface Submission {
  sessionId: string;
  student: { fullName: string; collegeName: string };
  paperName: string;
  submittedAt: string | null;
}
interface PendingAnswer {
  sessionQuestionId: string;
  position: number;
  section: string;
  question: string;
  answer: string | null;
  maxMarks: number;
}
interface ReviewOut {
  student: { fullName: string; registrationNumber: string };
  session: { id: string; paper: string; scores: { mcqScore: number | null; mcqMaxScore: number | null } };
  pending: PendingAnswer[];
}

const input$ = z.object({
  domainSlug: z.string().trim().optional(),
  sessionId: z.string().trim().max(64).optional(),
});

export const evaluationQueueWorkflow: WorkflowDefinition = {
  id: 'evaluation-queue',
  title: 'Coding Evaluation Queue & Score Finalisation',
  category: 'Evaluation Queue',
  goal: 'Take a submission from the coding review queue, have a reviewer mark each answer, confirm the final score, and place it in the domain percentiles.',
  description: 'The agent fetches the queue and prepares every pending coding answer side by side with its question. You enter the marks at each gate; it never invents marks.',
  risk: 'MEDIUM',
  estimatedSeconds: 45,
  roles: ['ADMIN', 'REVIEWER'],
  notes: [
    'MCQ answers are already scored automatically by Test Orbit at submission — there is nothing to "run" for them.',
    'Test Orbit recomputes totals after every evaluation; the "finalise" step verifies the result rather than overriding it.',
    'Percentiles are computed on demand from the reports API; nothing is stored.',
  ],
  inputs: [
    domainField('domainSlug', 'Domain (optional)', false, 'Limit the queue and percentiles to one domain.'),
    { key: 'sessionId', label: 'Session ID (optional)', type: 'text', placeholder: 'Leave empty to take the latest submission in the queue' },
  ],
  input: input$,
  steps: [
    toolStep({
      kind: 'tool',
      id: 'queue',
      title: 'Fetch review queue',
      description: 'Finished assessments with coding answers awaiting a reviewer.',
      tool: 'get_unevaluated_submissions',
      args: (ctx) => ({ domainSlug: input(ctx, 'domainSlug') || undefined, limit: 20 }),
    }),
    reasonStep({
      id: 'pick',
      title: 'Choose a submission',
      description: 'Use the given session, or the latest one in the queue.',
      think: (ctx) => {
        const queue = out<{ total: number; submissions: Submission[] }>(ctx, 'queue');
        const wanted = input<string | undefined>(ctx, 'sessionId');
        if (wanted) return { thoughts: [`Using the requested session ${wanted}.`], vars: { sessionId: wanted } };
        const first = queue.submissions[0];
        if (!first) return { thoughts: ['The coding review queue is empty.'], stop: 'Nothing to evaluate — every submitted coding answer has been marked.' };
        return { thoughts: [`${plural(queue.total, 'submission')} waiting. Taking ${first.student.fullName} (${first.paperName}).`], vars: { sessionId: first.sessionId } };
      },
    }),
    toolStep({
      kind: 'tool',
      id: 'review',
      title: 'Prepare answers for review',
      description: 'Each unevaluated coding answer with its question and maximum marks.',
      tool: 'get_coding_answers_for_review',
      args: (ctx) => ({ sessionId: v<string>(ctx, 'sessionId') }),
      stopIf: (o) => ((o.pending as PendingAnswer[]).length ? null : 'This session has no unevaluated coding answers.'),
      observe: (o) => {
        const r = o as unknown as ReviewOut;
        const blank = r.pending.filter((p) => !p.answer?.trim()).length;
        return [`${plural(r.pending.length, 'coding answer')} to mark for ${r.student.fullName}; MCQ already scored ${r.session.scores.mcqScore ?? 0}/${r.session.scores.mcqMaxScore ?? 0}.`, ...(blank ? [`${blank} answer(s) are blank — consider 0 marks.`] : [])];
      },
    }),
    toolStep<PendingAnswer>({
      kind: 'tool',
      id: 'evaluate',
      title: 'Mark coding answers',
      description: 'One gate per answer: the reviewer enters the marks.',
      tool: 'evaluate_coding_answer',
      forEach: {
        items: (ctx) => out<ReviewOut>(ctx, 'review').pending,
        key: (a) => a.sessionQuestionId,
        label: (a) => `Q${a.position} (section ${a.section}, max ${a.maxMarks})`,
      },
      args: (ctx, a) => ({ sessionId: v<string>(ctx, 'sessionId'), sessionQuestionId: a!.sessionQuestionId, comment: '' }),
      approval: {
        prompt: (_ctx, _args, a) => `Enter the marks for Q${a!.position} (0–${a!.maxMarks}) and approve to record them.`,
        assessment: (ctx, a) => [
          `Candidate: ${out<ReviewOut>(ctx, 'review').student.fullName}`,
          a!.answer?.trim() ? `Answer length: ${a!.answer.length} characters` : 'The candidate left this answer blank',
          'Marks are final once recorded; later changes need an audited correction in Test Orbit.',
        ],
        details: (_ctx, a) => [
          { label: `Question ${a!.position}`, content: a!.question, format: 'text' as const },
          { label: 'Candidate’s answer', content: a!.answer?.trim() ? a!.answer : '(blank)', format: 'code' as const },
        ],
        editable: (_ctx, a) => [
          { key: 'marksAwarded', label: `Marks (0–${a!.maxMarks})`, type: 'number', min: 0, max: a!.maxMarks, step: 0.5, required: true },
          { key: 'comment', label: 'Reviewer comment', type: 'textarea' },
        ],
      },
    }),
    toolStep({
      kind: 'tool',
      id: 'finalize',
      title: 'Verify final score',
      description: 'Read back the totals Test Orbit recomputed.',
      tool: 'finalize_session_score',
      args: (ctx) => ({ sessionId: v<string>(ctx, 'sessionId') }),
    }),
    toolStep({
      kind: 'tool',
      id: 'percentiles',
      title: 'Place in domain percentiles',
      description: 'Distribution of finished assessments and this candidate’s rank.',
      tool: 'recalculate_attempt_percentiles',
      args: (ctx) => ({ domainSlug: input(ctx, 'domainSlug') || undefined, sessionId: v<string>(ctx, 'sessionId') }),
      optional: true,
    }),
  ],
  summarize: (ctx, o) => {
    const fin = ctx.outputs.finalize as { student: { fullName: string }; scores: { totalScore: number | null; maxScore: number | null; evaluationStatus: string }; pendingCodingAnswers: number } | undefined;
    const marked = ((ctx.outputs.evaluate as unknown[] | undefined) ?? []).filter(Boolean).length;
    const pct = ctx.outputs.percentiles as { session: { percentileRank: number; scorePercent: number } | null; distribution: { p50?: number } } | null | undefined;
    if (!fin) return { headline: o.stopReason ?? 'No submission was evaluated', highlights: [], nextActions: [] };
    const complete = fin.scores.evaluationStatus === 'COMPLETE';
    return {
      headline: complete ? `${fin.student.fullName} fully evaluated: ${fin.scores.totalScore}/${fin.scores.maxScore}` : `${fin.student.fullName}: ${fin.pendingCodingAnswers} answer(s) still unmarked`,
      highlights: [
        { label: 'Answers marked now', value: String(marked) },
        { label: 'Total score', value: fin.scores.totalScore === null ? 'Pending' : `${fin.scores.totalScore}/${fin.scores.maxScore}`, tone: complete ? 'success' : 'warn' },
        ...(pct?.session ? [{ label: 'Percentile rank', value: `P${pct.session.percentileRank} (${pct.session.scorePercent}%)` }] : []),
        ...(pct?.distribution.p50 !== undefined ? [{ label: 'Median', value: `${pct.distribution.p50}%` }] : []),
      ],
      nextActions: complete ? ['Run the workflow again for the next submission in the queue.'] : ['Re-run for this session to mark the remaining answers.'],
    };
  },
};
