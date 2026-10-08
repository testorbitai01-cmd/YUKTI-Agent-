import { z } from 'zod';
import type { AssessmentDetail, AssessmentListItem, Paged, ReportPage, ReportRow } from '../../testorbit/types.js';
import { defineTool, domainSlug, id, isoDate, limit, truncate, type ToolContext } from '../tool.js';

const MAX_ANSWER_CHARS = 20_000;
const PERCENTILE_PAGE_SIZE = 100;
const PERCENTILE_MAX_PAGES = 20;

const getAssessment = (sessionId: string, ctx: ToolContext) =>
  ctx.api.json<AssessmentDetail>('GET', `/admin/assessments/${encodeURIComponent(sessionId)}`, ctx.credential, { signal: ctx.signal });

const pendingCoding = (d: AssessmentDetail) => d.questions.filter((q) => q.type === 'CODING' && q.marksAwarded === null);

const reportFilters = z.object({
  domainSlug: domainSlug.optional(),
  college: z.string().trim().max(200).optional(),
  from: isoDate.optional().describe('Assessments started on or after (YYYY-MM-DD)'),
  to: isoDate.optional().describe('Assessments started on or before (YYYY-MM-DD)'),
});
type ReportFilters = z.output<typeof reportFilters>;
const reportQuery = (f: ReportFilters) => ({ domain: f.domainSlug, college: f.college, from: f.from, to: f.to });

/** Score used for ranking: total when fully evaluated, otherwise the auto-scored MCQ part. */
const rankScore = (r: ReportRow) => (r.totalScore !== null && r.maxScore ? (r.totalScore / r.maxScore) * 100 : r.mcqScore !== null && r.mcqMaxScore ? (r.mcqScore / r.mcqMaxScore) * 100 : null);

/** Nearest-rank percentile on an ascending array. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

/** Percentage of scores strictly below `value`, plus half of the ties (standard percentile rank). */
export function percentileRank(sorted: number[], value: number): number {
  if (!sorted.length) return NaN;
  const below = sorted.filter((v) => v < value).length;
  const equal = sorted.filter((v) => v === value).length;
  return ((below + equal / 2) / sorted.length) * 100;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export const getDashboardMetrics = defineTool({
  name: 'get_dashboard_metrics',
  title: 'Get dashboard metrics',
  service: 'analytics',
  description: 'Live drive metrics: students, sessions by status, pending re-entries, pending coding reviews, average MCQ %, per-domain counts and score distribution.',
  risk: 'read',
  requiresApproval: false,
  idempotent: true,
  input: z.object({ timeZone: z.string().trim().max(64).default('Asia/Kolkata') }),
  async handler(args, ctx) {
    const r = await ctx.api.json<{ cards: Record<string, number | null>; statusBreakdown: unknown; domains: unknown; scoreDistribution: unknown }>('GET', '/admin/dashboard', ctx.credential, {
      query: { tz: args.timeZone },
      signal: ctx.signal,
    });
    const c = r.cards;
    return {
      summary: `${c.totalStudents} students, ${c.inProgress} in progress, ${c.pendingReentry} re-entries and ${c.pendingCodingReview} coding reviews pending`,
      data: { cards: c, statusBreakdown: r.statusBreakdown, domains: r.domains, scoreDistribution: r.scoreDistribution },
    };
  },
});

export const getUnevaluatedSubmissions = defineTool({
  name: 'get_unevaluated_submissions',
  title: 'Get coding review queue',
  service: 'analytics',
  description: 'Finished assessments whose coding answers still await a human reviewer (evaluation status PENDING_MANUAL_REVIEW). MCQs are already scored automatically at submission.',
  risk: 'read',
  requiresApproval: false,
  idempotent: true,
  input: z.object({ domainSlug: domainSlug.optional(), limit: limit(50, 10) }),
  async handler(args, ctx) {
    const r = await ctx.api.json<Paged<AssessmentListItem>>('GET', '/admin/assessments', ctx.credential, {
      query: { evaluationStatus: 'PENDING_MANUAL_REVIEW', domain: args.domainSlug, pageSize: args.limit },
      signal: ctx.signal,
    });
    return {
      summary: `${r.total} submission${r.total === 1 ? '' : 's'} awaiting coding review`,
      data: { total: r.total, submissions: r.items.map((s) => ({ sessionId: s.id, student: s.student, domainName: s.domainName, paperName: s.paperName, submittedAt: s.submittedAt })) },
    };
  },
});

export const getCodingAnswersForReview = defineTool({
  name: 'get_coding_answers_for_review',
  title: 'Get coding answers for review',
  service: 'analytics',
  description: 'The unevaluated coding answers of one finished session: question, the candidate’s code and the maximum marks.',
  risk: 'read',
  requiresApproval: false,
  idempotent: true,
  input: z.object({ sessionId: id('sessionId') }),
  async handler(args, ctx) {
    const d = await getAssessment(args.sessionId, ctx);
    const pending = pendingCoding(d);
    return {
      summary: `${d.student.fullName}: ${pending.length} coding answer${pending.length === 1 ? '' : 's'} to evaluate`,
      data: {
        session: { id: d.id, status: d.status, paper: d.paper.name, scores: d.scores },
        student: d.student,
        pending: pending.map((q) => ({
          sessionQuestionId: q.id,
          position: q.position,
          section: q.section,
          question: truncate(q.text, 2000),
          answer: q.answerText ? truncate(q.answerText, MAX_ANSWER_CHARS) : null,
          maxMarks: q.marks,
        })),
      },
    };
  },
});

export const evaluateCodingAnswer = defineTool({
  name: 'evaluate_coding_answer',
  title: 'Evaluate coding answer',
  service: 'analytics',
  description: 'Record a reviewer’s marks for one coding answer (first evaluation only). Test Orbit recomputes the session totals immediately.',
  risk: 'write',
  requiresApproval: true,
  idempotent: false,
  input: z.object({
    sessionId: id('sessionId'),
    sessionQuestionId: id('sessionQuestionId'),
    marksAwarded: z.coerce.number().min(0).max(100).refine((v) => Number.isInteger(v * 100), 'Use at most 2 decimal places'),
    comment: z.string().trim().max(2000).optional(),
  }),
  async handler(args, ctx) {
    const d = await ctx.api.json<AssessmentDetail>(
      'PUT',
      `/admin/assessments/${encodeURIComponent(args.sessionId)}/questions/${encodeURIComponent(args.sessionQuestionId)}/evaluation`,
      ctx.credential,
      { body: { marksAwarded: args.marksAwarded, comment: args.comment ?? '' }, signal: ctx.signal },
    );
    return {
      summary: `Awarded ${args.marksAwarded} mark${args.marksAwarded === 1 ? '' : 's'}; session is ${d.scores.evaluationStatus === 'COMPLETE' ? 'fully evaluated' : 'still pending other answers'}`,
      data: { sessionQuestionId: args.sessionQuestionId, marksAwarded: args.marksAwarded, scores: d.scores },
    };
  },
});

export const finalizeSessionScore = defineTool({
  name: 'finalize_session_score',
  title: 'Verify final score',
  service: 'analytics',
  description: 'Read back a session’s totals after evaluation. Test Orbit recomputes totals automatically on every evaluation; this confirms whether the session is COMPLETE.',
  risk: 'read',
  requiresApproval: false,
  idempotent: true,
  input: z.object({ sessionId: id('sessionId') }),
  async handler(args, ctx) {
    const d = await getAssessment(args.sessionId, ctx);
    const remaining = pendingCoding(d).length;
    const s = d.scores;
    return {
      summary: s.evaluationStatus === 'COMPLETE' ? `Final score ${s.totalScore}/${s.maxScore}` : `Not final: ${remaining} coding answer${remaining === 1 ? '' : 's'} still pending`,
      data: { sessionId: d.id, student: d.student, scores: s, pendingCodingAnswers: remaining },
    };
  },
});

export const recalculateAttemptPercentiles = defineTool({
  name: 'recalculate_attempt_percentiles',
  title: 'Compute score percentiles',
  service: 'analytics',
  description:
    'Compute the score distribution (P25/P50/P75/P90) of finished assessments for a domain and, optionally, one session’s percentile rank. Calculated on demand from the reports API; nothing is stored.',
  risk: 'read',
  requiresApproval: false,
  idempotent: true,
  input: reportFilters.extend({ sessionId: id('sessionId').optional() }),
  async handler(args, ctx) {
    const rows: ReportRow[] = [];
    let total = 0;
    for (let page = 1; page <= PERCENTILE_MAX_PAGES; page++) {
      const r = await ctx.api.json<ReportPage>('GET', '/admin/reports', ctx.credential, { query: { ...reportQuery(args), page, pageSize: PERCENTILE_PAGE_SIZE }, signal: ctx.signal });
      rows.push(...r.items);
      total = r.total;
      if (rows.length >= r.total || !r.items.length) break;
    }
    const finished = rows.filter((r) => r.status === 'SUBMITTED' || r.status === 'EXPIRED' || r.status === 'TERMINATED');
    const scores = finished.map(rankScore).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const ranked = finished
      .map((r) => ({ r, score: rankScore(r) }))
      .filter((x): x is { r: ReportRow; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score);
    const topCandidates = ranked.slice(0, 5).map(({ r, score }) => ({ sessionId: r.sessionId, student: r.student.fullName, registrationNumber: r.student.registrationNumber, scorePercent: round1(score) }));
    const target = args.sessionId ? finished.find((r) => r.sessionId === args.sessionId) : undefined;
    const targetScore = target ? rankScore(target) : null;
    const distribution = scores.length
      ? { candidates: scores.length, p25: round1(percentile(scores, 25)), p50: round1(percentile(scores, 50)), p75: round1(percentile(scores, 75)), p90: round1(percentile(scores, 90)), max: round1(scores.at(-1)!) }
      : { candidates: 0 };
    return {
      summary: scores.length
        ? `Median ${distribution.p50}% across ${scores.length} finished assessment${scores.length === 1 ? '' : 's'}${targetScore !== null ? `; selected session at P${round1(percentileRank(scores, targetScore))}` : ''}`
        : 'No finished, scored assessments match these filters yet',
      data: {
        basis: 'Percent of max score (total when fully evaluated, otherwise MCQ only)',
        sampled: rows.length,
        totalMatching: total,
        truncated: rows.length < total,
        distribution,
        topCandidates,
        session: target && targetScore !== null ? { sessionId: target.sessionId, student: target.student, scorePercent: round1(targetScore), percentileRank: round1(percentileRank(scores, targetScore)) } : null,
      },
    };
  },
});

export const generateDomainReport = defineTool({
  name: 'generate_domain_report',
  title: 'Generate domain report',
  service: 'analytics',
  description: 'Aggregate results for a domain / college / date range: sessions, finalised, pending review, average/high/low MCQ and average total score.',
  risk: 'read',
  requiresApproval: false,
  idempotent: true,
  input: reportFilters,
  async handler(args, ctx) {
    const r = await ctx.api.json<ReportPage>('GET', '/admin/reports', ctx.credential, { query: { ...reportQuery(args), pageSize: 5 }, signal: ctx.signal });
    const s = r.summary;
    return {
      summary: `${s.sessions} session${s.sessions === 1 ? '' : 's'}, ${s.finalized} finalised, avg MCQ ${s.averageMcqScore ?? '—'}/${s.averageMcqMax ?? '—'}, ${s.pendingReview} pending review`,
      data: { filters: args, summary: s, latest: r.items.map((x) => ({ sessionId: x.sessionId, student: x.student.fullName, status: x.status, totalScore: x.totalScore, maxScore: x.maxScore })) },
    };
  },
});

export const generateCandidateScorecard = defineTool({
  name: 'generate_candidate_scorecard',
  title: 'Generate candidate scorecard',
  service: 'analytics',
  description: 'Scorecard for one session: totals, section-wise MCQ/coding marks, answered counts, time used and proctoring warnings.',
  risk: 'read',
  requiresApproval: false,
  idempotent: true,
  input: z.object({ sessionId: id('sessionId') }),
  async handler(args, ctx) {
    const d = await getAssessment(args.sessionId, ctx);
    const warnings = d.events.filter((e) => e.action === 'WARNING' || e.action === 'TERMINATED').length;
    return {
      summary: `${d.student.fullName}: ${d.scores.totalScore ?? 'pending'}/${d.scores.maxScore ?? '—'} (${d.statusLabel})`,
      data: {
        student: d.student,
        paper: d.paper,
        status: d.status,
        scores: d.scores,
        answered: `${d.answeredCount}/${d.totalQuestions}`,
        timeUsedMinutes: Math.round(d.timeUsedMs / 60_000),
        sections: d.sections,
        proctoringWarnings: warnings,
      },
    };
  },
});

export const exportResultsCsv = defineTool({
  name: 'export_results_csv',
  title: 'Export results CSV',
  service: 'analytics',
  description: 'Export assessment results (contains personal data: names, registration numbers, mobile numbers, college emails). ADMIN only; every export is audit-logged by Test Orbit.',
  risk: 'read',
  requiresApproval: true,
  idempotent: true,
  input: reportFilters.extend({ status: z.enum(['SUBMITTED', 'EXPIRED', 'TERMINATED', 'IN_PROGRESS', 'INTERRUPTED', 'FLAGGED_FOR_REVIEW']).optional() }),
  async handler(args, ctx) {
    const csv = await ctx.api.text('/admin/reports/export.csv', ctx.credential, { query: { ...reportQuery(args), status: args.status }, signal: ctx.signal });
    const rows = Math.max(0, csv.text.split(/\r?\n/).filter((l) => l.trim()).length - 1);
    const name = csv.filename ?? `test-orbit-report-${new Date().toISOString().slice(0, 10)}.csv`;
    return {
      summary: `Exported ${rows} row${rows === 1 ? '' : 's'} (${name})`,
      data: { rows, bytes: Buffer.byteLength(csv.text), filename: name },
      resources: [{ uri: `testorbit://reports/${name}`, name, mimeType: 'text/csv', text: csv.text }],
    };
  },
});

export const analyticsTools = [
  getDashboardMetrics,
  getUnevaluatedSubmissions,
  getCodingAnswersForReview,
  evaluateCodingAnswer,
  finalizeSessionScore,
  recalculateAttemptPercentiles,
  generateDomainReport,
  generateCandidateScorecard,
  exportResultsCsv,
];
