/**
 * 🛡️ Candidate identity, education & device audit (and optional domain correction).
 */
import { z } from 'zod';
import { reasonStep, toolStep, type WorkflowDefinition } from '../types.js';
import { candidateField, domainField, input, out, pickOneStudent, plural, v, type StudentRef } from './common.js';

interface Education {
  level: 'SSC' | 'HSC' | 'UG' | 'PG';
  institutionName: string;
  yearOfCompletion: number;
  gradeType: string;
  score: number | null;
}
interface Profile {
  student: {
    fullName: string;
    registrationNumber: string;
    yearOfPassing: number;
    domain: { slug: string; name: string };
    domainLockedAt: string | null;
    archivedAt: string | null;
    education: Education[];
  };
  photo: { available: boolean };
  sessions: { status: string }[];
}
interface DeviceLogs {
  deviceCheckPassed: boolean;
  identityPhoto: { available: boolean };
  deviceEvents: { type: string }[];
}

const GRADE_MAX: Record<string, number> = { PERCENTAGE: 100, CGPA_10: 10, CGPA_4: 4, GPA_5: 5 };

/** Education findings: required levels, chronology, and the UG year vs the declared year of passing. */
export function auditEducation(p: Profile): { flags: string[]; facts: string[] } {
  const flags: string[] = [];
  const facts: string[] = [];
  const by = new Map(p.student.education.map((e) => [e.level, e]));
  for (const level of ['SSC', 'HSC', 'UG'] as const) if (!by.has(level)) flags.push(`${level} record missing`);
  const order = (['SSC', 'HSC', 'UG', 'PG'] as const).map((l) => by.get(l)).filter((e): e is Education => Boolean(e));
  for (let i = 1; i < order.length; i++) {
    if (order[i]!.yearOfCompletion <= order[i - 1]!.yearOfCompletion) flags.push(`${order[i]!.level} (${order[i]!.yearOfCompletion}) is not after ${order[i - 1]!.level} (${order[i - 1]!.yearOfCompletion})`);
  }
  for (const e of order) {
    const max = GRADE_MAX[e.gradeType] ?? 100;
    const pct = e.score === null ? null : Math.round((e.score / max) * 1000) / 10;
    facts.push(`${e.level}: ${e.institutionName}, ${e.yearOfCompletion}, ${e.score ?? '—'} (${e.gradeType.replace('_', ' ').toLowerCase()}${pct !== null ? ` ≈ ${pct}%` : ''})`);
  }
  const ug = by.get('UG');
  if (ug && ug.yearOfCompletion !== p.student.yearOfPassing && !by.get('PG')) flags.push(`UG completion ${ug.yearOfCompletion} differs from declared year of passing ${p.student.yearOfPassing}`);
  if (p.student.archivedAt) flags.push('Student record is archived');
  return { flags, facts };
}

const input$ = z.object({
  candidate: z.string().trim().min(2).max(120),
  targetDomainSlug: z.string().trim().optional(),
});

export const candidateAuditWorkflow: WorkflowDefinition = {
  id: 'candidate-audit',
  title: 'Candidate Identity, Education & Device Audit',
  category: 'Onboarding',
  goal: 'Audit a registered candidate’s education history, identity photo and camera/microphone readiness, and correct their domain before the assessment.',
  description: 'Reads the profile and device logs, flags gaps and inconsistencies, and — only if you ask and the domain is not yet locked — moves the candidate to another domain after your approval.',
  risk: 'LOW',
  estimatedSeconds: 12,
  roles: ['ADMIN', 'REVIEWER'],
  notes: [
    'Registering candidates is intentionally not an agent action: registration is the candidate’s own consented step (with device check and photo). This workflow audits candidates who have registered.',
    'Changing the domain needs the ADMIN role and is refused by Test Orbit once the candidate has started an assessment.',
  ],
  inputs: [candidateField, domainField('targetDomainSlug', 'Move to domain (optional)', false, 'Only before their assessment starts.')],
  input: input$,
  steps: [
    toolStep({ kind: 'tool', id: 'find', title: 'Find candidate', description: 'Search by registration number, name or mobile.', tool: 'search_students', args: (ctx) => ({ query: input(ctx, 'candidate'), limit: 10 }) }),
    reasonStep({ id: 'identify', title: 'Identify exactly one candidate', description: 'Refuse to guess when ambiguous.', think: (ctx) => pickOneStudent(out<{ students: StudentRef[] }>(ctx, 'find').students, input(ctx, 'candidate')) }),
    toolStep({ kind: 'tool', id: 'profile', title: 'Read profile & education', description: 'Registration details and SSC/HSC/UG/PG records.', tool: 'get_student_profile', args: (ctx) => ({ studentId: v<StudentRef>(ctx, 'student').id }) }),
    reasonStep({
      id: 'education',
      title: 'Audit education history',
      description: 'Required levels, chronology and declared year of passing.',
      think: (ctx) => {
        const a = auditEducation(out<Profile>(ctx, 'profile'));
        return { thoughts: [...a.facts, a.flags.length ? `Flags: ${a.flags.join('; ')}` : 'Education history is complete and consistent.'], vars: { educationFlags: a.flags } };
      },
    }),
    toolStep({ kind: 'tool', id: 'devices', title: 'Read device-check logs', description: 'Camera/mic check, identity photo and device events.', tool: 'get_device_check_logs', args: (ctx) => ({ studentId: v<StudentRef>(ctx, 'student').id }) }),
    reasonStep({
      id: 'verdict',
      title: 'Readiness verdict',
      description: 'Combine education and device findings.',
      think: (ctx) => {
        const d = out<DeviceLogs>(ctx, 'devices');
        const flags = [...v<string[]>(ctx, 'educationFlags')];
        if (!d.deviceCheckPassed) flags.push('Camera/microphone check not completed');
        if (!d.identityPhoto.available) flags.push('No identity photo on file');
        const disconnects = d.deviceEvents.filter((e) => e.type.endsWith('_DISCONNECTED') || e.type.endsWith('_UNAVAILABLE')).length;
        if (disconnects) flags.push(`${plural(disconnects, 'camera/microphone problem')} during assessments`);
        const verdict = flags.length ? 'ATTENTION' : 'READY';
        return { thoughts: [verdict === 'READY' ? 'Verdict: READY — nothing to fix.' : `Verdict: ATTENTION — ${flags.join('; ')}.`], vars: { flags, verdict } };
      },
    }),
    toolStep({
      kind: 'tool',
      id: 'domain',
      title: 'Correct assessment domain',
      description: 'Move the candidate (before the domain locks).',
      tool: 'assign_student_domain',
      when: (ctx) => {
        const target = input<string | undefined>(ctx, 'targetDomainSlug');
        const s = out<Profile>(ctx, 'profile').student;
        if (!target) return 'No domain change requested';
        if (target === s.domain.slug) return `Already in ${s.domain.name}`;
        if (s.domainLockedAt) return `Domain is locked (assessment started ${new Date(s.domainLockedAt).toLocaleString('en-IN')})`;
        if (ctx.operator.role !== 'ADMIN') return 'Changing the domain needs the ADMIN role';
        return true;
      },
      args: (ctx) => ({ studentId: v<StudentRef>(ctx, 'student').id, domainSlug: input(ctx, 'targetDomainSlug') }),
      approval: {
        prompt: (ctx) => `Move ${v<StudentRef>(ctx, 'student').fullName} from ${out<Profile>(ctx, 'profile').student.domain.name} to "${input(ctx, 'targetDomainSlug')}"?`,
        assessment: () => ['The candidate will receive the target domain’s active paper when they start.', 'The change is recorded in the Test Orbit audit log under your name.'],
      },
    }),
  ],
  summarize: (ctx, o) => {
    const p = ctx.outputs.profile as Profile | undefined;
    const verdict = ctx.vars.verdict as string | undefined;
    const flags = (ctx.vars.flags as string[] | undefined) ?? [];
    const moved = ctx.outputs.domain as { changed: boolean; to?: string } | null | undefined;
    if (!p) return { headline: o.stopReason ?? 'Audit did not complete', highlights: [], nextActions: [] };
    return {
      headline: `${p.student.fullName}: ${verdict ?? 'audited'}`,
      highlights: [
        { label: 'Registration no.', value: p.student.registrationNumber, copyable: true },
        { label: 'Verdict', value: verdict ?? '—', tone: verdict === 'READY' ? 'success' : 'warn' },
        { label: 'Domain', value: moved?.changed ? `→ ${moved.to}` : p.student.domain.name },
        { label: 'Flags', value: String(flags.length) },
      ],
      nextActions: flags.length ? flags.map((f) => `Resolve: ${f}`) : ['No action needed.'],
    };
  },
};
