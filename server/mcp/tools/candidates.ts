import { z } from 'zod';
import type { EducationEntry, Paged, StudentDetail, StudentListItem } from '../../testorbit/types.js';
import { defineTool, domainSlug, id, limit, type ToolContext } from '../tool.js';

const SESSION_STATUS = ['IN_PROGRESS', 'INTERRUPTED', 'FLAGGED_FOR_REVIEW', 'SUBMITTED', 'EXPIRED', 'TERMINATED', 'NOT_STARTED'] as const;
const DEVICE_EVENT_TYPES = new Set([
  'CAMERA_DISCONNECTED',
  'MICROPHONE_DISCONNECTED',
  'CAMERA_MONITORING_UNAVAILABLE',
  'MICROPHONE_MONITORING_UNAVAILABLE',
  'NETWORK_OFFLINE',
  'NETWORK_RESTORED',
  'PAGE_UNLOAD',
]);

const getStudent = (studentId: string, ctx: ToolContext) =>
  ctx.api.json<StudentDetail>('GET', `/admin/students/${encodeURIComponent(studentId)}`, ctx.credential, { signal: ctx.signal });

export const searchStudents = defineTool({
  name: 'search_students',
  title: 'Search students',
  service: 'candidates',
  description: 'Find candidates by name, registration number, college email or mobile number. Returns ids for the other candidate tools.',
  risk: 'read',
  requiresApproval: false,
  idempotent: true,
  input: z.object({
    query: z.string().trim().min(2, 'Enter at least 2 characters').max(120).describe('Name, registration number, college email or mobile number'),
    domainSlug: domainSlug.optional(),
    status: z.enum(SESSION_STATUS).optional().describe('Filter by assessment status'),
    limit: limit(25, 10),
  }),
  async handler(args, ctx) {
    const r = await ctx.api.json<Paged<StudentListItem>>('GET', '/admin/students', ctx.credential, {
      query: { search: args.query, domain: args.domainSlug, status: args.status, pageSize: args.limit },
      signal: ctx.signal,
    });
    return {
      summary: `${r.total} student${r.total === 1 ? '' : 's'} match "${args.query}"`,
      data: { total: r.total, students: r.items },
    };
  },
});

export const getStudentProfile = defineTool({
  name: 'get_student_profile',
  title: 'Get student profile',
  service: 'candidates',
  description: 'Registration details, education history (SSC, HSC, UG, PG), identity-photo status and an assessment summary for one candidate. Excludes answers, answer keys and personal email.',
  risk: 'read',
  requiresApproval: false,
  idempotent: true,
  input: z.object({ studentId: id('studentId') }),
  async handler(args, ctx) {
    const d = await getStudent(args.studentId, ctx);
    const s = d.student;
    return {
      summary: `${s.fullName} (${s.registrationNumber}) — ${s.domain.name}, ${d.sessions.length} assessment${d.sessions.length === 1 ? '' : 's'}`,
      data: {
        student: {
          id: s.id,
          fullName: s.fullName,
          registrationNumber: s.registrationNumber,
          mobileNumber: s.mobileNumber,
          collegeEmail: s.collegeEmail,
          collegeName: s.collegeName,
          department: s.department,
          yearOfPassing: s.yearOfPassing,
          domain: s.domain,
          domainLockedAt: s.domainLockedAt,
          deviceCheckCompletedAt: s.deviceCheckCompletedAt,
          archivedAt: s.archivedAt,
          education: s.education,
        },
        photo: d.photo,
        sessions: d.sessions.map((x) => ({
          id: x.id,
          status: x.status,
          statusLabel: x.statusLabel,
          paper: x.paper.name,
          startedAt: x.startedAt,
          submittedAt: x.submittedAt,
          remainingMs: x.remainingMs,
          scores: x.scores,
          answered: `${x.answeredCount}/${x.totalQuestions}`,
          warnings: x.events.filter((e) => e.action === 'WARNING' || e.action === 'TERMINATED').length,
          reentryRequests: x.reentryRequests.map((r) => ({ id: r.id, status: r.status, trigger: r.trigger, createdAt: r.createdAt })),
        })),
      },
    };
  },
});

export const getDeviceCheckLogs = defineTool({
  name: 'get_device_check_logs',
  title: 'Get device-check logs',
  service: 'candidates',
  description: 'Device readiness for one candidate: camera/microphone check completion, identity photo, and every camera, microphone, network and page-unload event recorded during their assessments.',
  risk: 'read',
  requiresApproval: false,
  idempotent: true,
  input: z.object({ studentId: id('studentId') }),
  async handler(args, ctx) {
    const d = await getStudent(args.studentId, ctx);
    const deviceEvents = d.sessions.flatMap((x) =>
      x.events.filter((e) => DEVICE_EVENT_TYPES.has(e.type)).map((e) => ({ sessionId: x.id, type: e.type, label: e.label, action: e.action, createdAt: e.createdAt })),
    );
    const passed = Boolean(d.student.deviceCheckCompletedAt);
    return {
      summary: `Device check ${passed ? 'completed' : 'NOT completed'}; identity photo ${d.photo.available ? 'on file' : 'missing'}; ${deviceEvents.length} device event${deviceEvents.length === 1 ? '' : 's'}`,
      data: { deviceCheckCompletedAt: d.student.deviceCheckCompletedAt, deviceCheckPassed: passed, identityPhoto: d.photo, deviceEvents },
    };
  },
});

/** Test Orbit's registration schema wants education keyed by level. */
function educationPayload(education: EducationEntry[]) {
  const by = Object.fromEntries(education.map((e) => [e.level, { institutionName: e.institutionName, yearOfCompletion: e.yearOfCompletion, major: e.major ?? '', gradeType: e.gradeType, score: e.score ?? 0 }]));
  return { SSC: by.SSC, HSC: by.HSC, UG: by.UG, PG: by.PG ?? null };
}

export const assignStudentDomain = defineTool({
  name: 'assign_student_domain',
  title: 'Assign student domain',
  service: 'candidates',
  description: 'Move a candidate to another assessment domain. Refused by Test Orbit once the candidate has started an assessment (the domain is then locked).',
  risk: 'write',
  requiresApproval: true,
  idempotent: true,
  input: z.object({ studentId: id('studentId'), domainSlug }),
  async handler(args, ctx) {
    const d = await getStudent(args.studentId, ctx);
    const s = d.student;
    if (s.domain.slug === args.domainSlug) {
      return { summary: `${s.fullName} is already in ${s.domain.name}; nothing changed`, data: { changed: false, domain: s.domain } };
    }
    const r = await ctx.api.json<{ id: string; changedFields: string[] }>('PUT', `/admin/students/${encodeURIComponent(s.id)}`, ctx.credential, {
      body: {
        fullName: s.fullName,
        registrationNumber: s.registrationNumber,
        mobileNumber: s.mobileNumber,
        collegeEmail: s.collegeEmail,
        personalEmail: s.personalEmail,
        collegeName: s.collegeName,
        location: s.location,
        department: s.department,
        yearOfPassing: s.yearOfPassing,
        domainSlug: args.domainSlug,
        education: educationPayload(s.education),
      },
      signal: ctx.signal,
    });
    return {
      summary: `${s.fullName} moved from ${s.domain.slug} to ${args.domainSlug}`,
      data: { changed: true, from: s.domain.slug, to: args.domainSlug, changedFields: r.changedFields },
    };
  },
});

export const candidateTools = [searchStudents, getStudentProfile, getDeviceCheckLogs, assignStudentDomain];
