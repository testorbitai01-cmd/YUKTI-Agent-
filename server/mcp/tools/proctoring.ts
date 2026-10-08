import { z } from 'zod';
import type { AssessmentDetail, AssessmentListItem, Paged, ReentryListItem } from '../../testorbit/types.js';
import { defineTool, domainSlug, id, limit, reason } from '../tool.js';

export const listActiveSessions = defineTool({
  name: 'list_active_sessions',
  title: 'List live sessions',
  service: 'proctoring',
  description: 'Assessment sessions that are in progress, interrupted (connection lost) or flagged for review after a proctoring policy limit.',
  risk: 'read',
  requiresApproval: false,
  idempotent: true,
  input: z.object({
    status: z.enum(['IN_PROGRESS', 'INTERRUPTED', 'FLAGGED_FOR_REVIEW']).default('IN_PROGRESS'),
    domainSlug: domainSlug.optional(),
    search: z.string().trim().max(120).optional().describe('Student name, registration number or mobile'),
    limit: limit(50, 20),
  }),
  async handler(args, ctx) {
    const r = await ctx.api.json<Paged<AssessmentListItem>>('GET', '/admin/assessments', ctx.credential, {
      query: { status: args.status, domain: args.domainSlug, search: args.search, pageSize: args.limit },
      signal: ctx.signal,
    });
    return {
      summary: `${r.total} session${r.total === 1 ? '' : 's'} ${args.status.toLowerCase().replace(/_/g, ' ')}`,
      data: {
        total: r.total,
        sessions: r.items.map((s) => ({ id: s.id, student: s.student, domainName: s.domainName, paperName: s.paperName, status: s.status, startedAt: s.startedAt })),
      },
    };
  },
});

export const getProctoringEvents = defineTool({
  name: 'get_proctoring_events',
  title: 'Get proctoring events',
  service: 'proctoring',
  description: 'The proctoring log of one session (tab switches, window blur, faces, speech, camera/microphone, network) with per-type counts, warnings, session state and re-entry history.',
  risk: 'read',
  requiresApproval: false,
  idempotent: true,
  input: z.object({ sessionId: id('sessionId') }),
  async handler(args, ctx) {
    const d = await ctx.api.json<AssessmentDetail>('GET', `/admin/assessments/${encodeURIComponent(args.sessionId)}`, ctx.credential, { signal: ctx.signal });
    const byType: Record<string, number> = {};
    for (const e of d.events) byType[e.type] = (byType[e.type] ?? 0) + 1;
    const warnings = d.events.filter((e) => e.action === 'WARNING').length;
    const terminations = d.events.filter((e) => e.action === 'TERMINATED').length;
    return {
      summary: `${d.student.fullName}: ${d.events.length} event${d.events.length === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}, session ${d.statusLabel.toLowerCase()}`,
      data: {
        session: {
          id: d.id,
          status: d.status,
          statusLabel: d.statusLabel,
          paper: d.paper.name,
          startedAt: d.startedAt,
          lastHeartbeatAt: d.lastHeartbeatAt,
          remainingMs: d.remainingMs,
          resumeCount: d.resumeCount,
          terminationReason: d.terminationReason,
          answered: `${d.answeredCount}/${d.totalQuestions}`,
        },
        student: d.student,
        totals: { events: d.events.length, warnings, terminations, byType },
        events: d.events.slice(-50).map((e) => ({ type: e.type, label: e.label, ruleGroup: e.ruleGroup, action: e.action, warningNumber: e.warningNumber, createdAt: e.createdAt })),
        reentryRequests: d.reentryRequests,
      },
    };
  },
});

export const listReentryRequests = defineTool({
  name: 'list_reentry_requests',
  title: 'List re-entry requests',
  service: 'proctoring',
  description: 'Re-entry requests (opened automatically when a session is interrupted or flagged), with the session state and remaining time.',
  risk: 'read',
  requiresApproval: false,
  idempotent: true,
  input: z.object({
    search: z.string().trim().max(120).optional().describe('Student name, registration number or mobile'),
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'USED', 'CANCELLED']).default('PENDING'),
    limit: limit(50, 20),
  }),
  async handler(args, ctx) {
    const r = await ctx.api.json<Paged<ReentryListItem>>('GET', '/admin/reentry', ctx.credential, {
      query: { search: args.search, requestStatus: args.status, pageSize: args.limit },
      signal: ctx.signal,
    });
    return { summary: `${r.total} ${args.status.toLowerCase()} re-entry request${r.total === 1 ? '' : 's'}`, data: { total: r.total, requests: r.items } };
  },
});

export const approveReentryRequest = defineTool({
  name: 'approve_reentry_request',
  title: 'Approve re-entry',
  service: 'proctoring',
  description:
    'Approve a pending re-entry request: Test Orbit issues a single-use resume code (shown once) and applies the time adjustment. The student redeems it with their registration number on the session-status page.',
  risk: 'critical',
  requiresApproval: true,
  idempotent: false,
  input: z.object({
    reentryId: id('reentryId'),
    timeAdjustmentMinutes: z.coerce.number().int().min(-60).max(60).default(0).describe('Minutes added to (or removed from) the remaining time'),
    decisionReason: reason.describe('Recorded in the audit log'),
  }),
  async handler(args, ctx) {
    const r = await ctx.api.json<{ decision: string; resumeCode: string; resumeCodeExpiresAt: string }>(
      'POST',
      `/admin/reentry/${encodeURIComponent(args.reentryId)}/decision`,
      ctx.credential,
      { body: { decision: 'APPROVE', reason: args.decisionReason, timeAdjustmentMinutes: args.timeAdjustmentMinutes }, signal: ctx.signal },
    );
    return {
      summary: `Re-entry approved; one-time resume code valid until ${r.resumeCodeExpiresAt}`,
      data: { decision: r.decision, reentryId: args.reentryId, resumeCode: r.resumeCode, resumeCodeExpiresAt: r.resumeCodeExpiresAt, timeAdjustmentMinutes: args.timeAdjustmentMinutes },
    };
  },
});

export const terminateSession = defineTool({
  name: 'terminate_session',
  title: 'Terminate session',
  service: 'proctoring',
  description: 'Permanently end a session that has not finished (saved answers are scored). Open re-entry requests are cancelled. Cannot be undone.',
  risk: 'critical',
  requiresApproval: true,
  idempotent: false,
  input: z.object({ sessionId: id('sessionId'), reason: reason.describe('Recorded on the session and in the audit log') }),
  async handler(args, ctx) {
    const d = await ctx.api.json<AssessmentDetail>('POST', `/admin/assessments/${encodeURIComponent(args.sessionId)}/terminate`, ctx.credential, {
      body: { reason: args.reason },
      signal: ctx.signal,
    });
    return {
      summary: `Session terminated (${d.statusLabel})`,
      data: { sessionId: d.id, status: d.status, terminationReason: d.terminationReason, scores: d.scores },
    };
  },
});

export const proctoringTools = [listActiveSessions, getProctoringEvents, listReentryRequests, approveReentryRequest, terminateSession];
