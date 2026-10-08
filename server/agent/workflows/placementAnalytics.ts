/**
 * 📈 Placement analytics, scorecard & results export.
 */
import { z } from 'zod';
import { reasonStep, toolStep, type WorkflowDefinition } from '../types.js';
import { domainField, input, out, v } from './common.js';

interface Dashboard {
  cards: { totalStudents: number; inProgress: number; submitted: number; pendingReentry: number; pendingCodingReview: number; averageMcqPercent: number | null };
}
interface Report {
  summary: { sessions: number; finalized: number; pendingReview: number; averageMcqScore: number | null; averageMcqMax: number | null; averageTotalScore: number | null };
}
interface Percentiles {
  distribution: { candidates: number; p25?: number; p50?: number; p75?: number; p90?: number; max?: number };
  topCandidates: { sessionId: string; student: string; registrationNumber: string; scorePercent: number }[];
  truncated: boolean;
}

const optionalDate = z.union([z.literal(''), z.iso.date()]).optional();
const input$ = z.object({
  domainSlug: z.string().trim().optional(),
  from: optionalDate,
  to: optionalDate,
  sessionId: z.string().trim().max(64).optional(),
  exportCsv: z.boolean().default(true),
});

const filters = (ctx: Parameters<WorkflowDefinition['summarize']>[0]) => ({
  domainSlug: input<string | undefined>(ctx, 'domainSlug') || undefined,
  from: input<string | undefined>(ctx, 'from') || undefined,
  to: input<string | undefined>(ctx, 'to') || undefined,
});

export const placementAnalyticsWorkflow: WorkflowDefinition = {
  id: 'placement-analytics',
  title: 'Placement Analytics & Scorecard Export',
  category: 'Analytics',
  goal: 'Aggregate drive metrics, build the domain report and score distribution, produce a candidate scorecard, and export results to CSV.',
  description: 'Reads the dashboard and reports, computes percentiles and the top candidates, builds a scorecard (yours or the top scorer), then asks before exporting personal data.',
  risk: 'MEDIUM',
  estimatedSeconds: 20,
  roles: ['ADMIN'],
  notes: ['The CSV contains personal data (names, registration numbers, mobiles, college emails); Test Orbit audit-logs every export.'],
  inputs: [
    domainField('domainSlug', 'Domain (optional)', false),
    { key: 'from', label: 'From (YYYY-MM-DD)', type: 'text', placeholder: 'optional' },
    { key: 'to', label: 'To (YYYY-MM-DD)', type: 'text', placeholder: 'optional' },
    { key: 'sessionId', label: 'Scorecard for session (optional)', type: 'text', placeholder: 'Default: the top scorer' },
    { key: 'exportCsv', label: 'Export results CSV (asks first)', type: 'boolean', default: true },
  ],
  input: input$,
  steps: [
    toolStep({ kind: 'tool', id: 'metrics', title: 'Read drive metrics', description: 'Live dashboard counters.', tool: 'get_dashboard_metrics', args: () => ({ timeZone: 'Asia/Kolkata' }) }),
    toolStep({ kind: 'tool', id: 'report', title: 'Build domain report', description: 'Aggregates for the selected filters.', tool: 'generate_domain_report', args: (ctx) => filters(ctx) }),
    toolStep({ kind: 'tool', id: 'percentiles', title: 'Compute distribution', description: 'Percentiles and top candidates.', tool: 'recalculate_attempt_percentiles', args: (ctx) => filters(ctx) }),
    reasonStep({
      id: 'insights',
      title: 'Interpret results',
      description: 'Turn the numbers into findings and pick the scorecard subject.',
      think: (ctx) => {
        const m = out<Dashboard>(ctx, 'metrics').cards;
        const r = out<Report>(ctx, 'report').summary;
        const p = out<Percentiles>(ctx, 'percentiles');
        const thoughts = [
          `${r.sessions} sessions match; ${r.finalized} finalised; ${r.pendingReview} awaiting coding review.`,
          p.distribution.candidates ? `Scores: P25 ${p.distribution.p25}% · median ${p.distribution.p50}% · P75 ${p.distribution.p75}% · P90 ${p.distribution.p90}%.` : 'No finished, scored assessments yet.',
        ];
        if (r.pendingReview) thoughts.push(`${r.pendingReview} result(s) are provisional until coding answers are marked — run the Evaluation Queue first for final rankings.`);
        if (m.pendingReentry) thoughts.push(`${m.pendingReentry} re-entry request(s) are still pending across the drive.`);
        if (p.truncated) thoughts.push('More than 2,000 sessions match; percentiles use the first 2,000.');
        const chosen = input<string | undefined>(ctx, 'sessionId') || p.topCandidates[0]?.sessionId;
        if (chosen && !input(ctx, 'sessionId')) thoughts.push(`Scorecard subject: top scorer ${p.topCandidates[0]!.student} (${p.topCandidates[0]!.scorePercent}%).`);
        return { thoughts, vars: { scorecardSessionId: chosen ?? null } };
      },
    }),
    toolStep({
      kind: 'tool',
      id: 'scorecard',
      title: 'Generate scorecard',
      description: 'Section-wise marks, time used and warnings.',
      tool: 'generate_candidate_scorecard',
      when: (ctx) => (v<string | null>(ctx, 'scorecardSessionId') ? true : 'No scored session to build a scorecard for'),
      args: (ctx) => ({ sessionId: v<string>(ctx, 'scorecardSessionId') }),
      optional: true,
    }),
    toolStep({
      kind: 'tool',
      id: 'export',
      title: 'Export results CSV',
      description: 'Personal data — audit-logged by Test Orbit.',
      tool: 'export_results_csv',
      when: (ctx) => (input<boolean>(ctx, 'exportCsv') ? true : 'Export not requested'),
      args: (ctx) => filters(ctx),
      approval: {
        prompt: (ctx) => `Export ${out<Report>(ctx, 'report').summary.sessions} result row(s) containing personal data?`,
        assessment: () => ['Columns: name, registration number, mobile, college email, college, scores, warnings.', 'Store the file access-controlled and delete it when no longer needed.'],
      },
    }),
  ],
  summarize: (ctx, o) => {
    const r = (ctx.outputs.report as Report | undefined)?.summary;
    const p = ctx.outputs.percentiles as Percentiles | undefined;
    const card = ctx.outputs.scorecard as { student: { fullName: string }; scores: { totalScore: number | null; maxScore: number | null } } | null | undefined;
    const exported = ctx.outputs.export as { rows: number; filename: string } | null | undefined;
    if (!r) return { headline: o.stopReason ?? 'Analytics did not complete', highlights: [], nextActions: [] };
    return {
      headline: `${r.sessions} sessions analysed${exported ? `, ${exported.rows} rows exported` : ''}`,
      highlights: [
        { label: 'Finalised', value: `${r.finalized}/${r.sessions}` },
        { label: 'Median score', value: p?.distribution.p50 !== undefined ? `${p.distribution.p50}%` : '—' },
        ...(p?.topCandidates[0] ? [{ label: 'Top scorer', value: `${p.topCandidates[0].student} (${p.topCandidates[0].scorePercent}%)`, tone: 'success' as const }] : []),
        ...(card ? [{ label: 'Scorecard', value: `${card.student.fullName}: ${card.scores.totalScore ?? 'pending'}/${card.scores.maxScore ?? '—'}` }] : []),
        { label: 'Pending review', value: String(r.pendingReview), tone: r.pendingReview ? ('warn' as const) : ('success' as const) },
      ],
      nextActions: [
        ...(r.pendingReview ? ['Mark the pending coding answers (Evaluation Queue workflow) before publishing rankings.'] : []),
        ...(exported ? ['Download the CSV below; it is kept only in this run.'] : []),
      ],
    };
  },
};
