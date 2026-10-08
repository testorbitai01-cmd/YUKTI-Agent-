/**
 * 📝 Question paper assembly & readiness check.
 * observe (domain, pool depth, sample) → reason (fit the section plan to the pool) → act (create inactive
 * paper) → verify (readiness + dry-run draw) → act (activate, gated).
 */
import { z } from 'zod';
import { reasonStep, toolStep, type ReasonResult, type WorkflowDefinition } from '../types.js';
import { domainField, input, out, plural, v } from './common.js';

interface Pool {
  total: number;
  sections: Record<string, { mcq: number; coding: number; total: number }>;
}
interface DomainInfo {
  slug: string;
  name: string;
  isActive: boolean;
  activePaper: { id: string; name: string; ready: boolean } | null;
}
interface PaperOut {
  paper: { id: string; name: string; isActive: boolean; ready: boolean; totalQuestions: number; sections: { key: string; questionCount: number }[] };
}
interface PlannedSection {
  key: string;
  title: string;
  questionCount: number;
}

/** Parse "A:10, B:5, SQL:3" into ordered section requests. */
export function parseSectionPlan(plan: string): { key: string; count: number }[] {
  const seen = new Set<string>();
  return plan
    .split(/[,;\n]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = /^([A-Za-z0-9]{1,8})\s*[:=x×]\s*(\d{1,3})$/.exec(p);
      if (!m) throw new Error(`Cannot read "${p}" — use KEY:COUNT, e.g. A:10`);
      const key = m[1]!.toUpperCase();
      if (seen.has(key)) throw new Error(`Section ${key} appears twice`);
      seen.add(key);
      return { key, count: Number(m[2]) };
    });
}

/** Fit requested section counts to the eligible pool (or report the shortfall). */
export function planSections(plan: string, pool: Pool, autoFit: boolean): ReasonResult {
  let requested;
  try {
    requested = parseSectionPlan(plan);
  } catch (e) {
    return { thoughts: [(e as Error).message], stop: (e as Error).message };
  }
  if (!requested.length) return { thoughts: ['The section plan is empty.'], stop: 'Give at least one section, e.g. A:10' };
  const thoughts: string[] = [];
  const shortfalls: string[] = [];
  const sections: PlannedSection[] = requested.map(({ key, count }) => {
    const available = pool.sections[key]?.total ?? 0;
    if (count > available) shortfalls.push(`section ${key} wants ${count}, pool has ${available}`);
    const questionCount = autoFit ? Math.min(count, available) : count;
    thoughts.push(`Section ${key}: requested ${count}, eligible ${available}${autoFit && questionCount < count ? ` → reduced to ${questionCount}` : ''}`);
    return { key, title: `Section ${key}`, questionCount };
  });
  if (shortfalls.length && !autoFit) {
    return { thoughts: [...thoughts, 'Auto-fit is off, so I will not create a paper Test Orbit would reject.'], stop: `Not enough eligible questions: ${shortfalls.join('; ')}. Add questions or enable auto-fit.` };
  }
  const total = sections.reduce((n, s) => n + s.questionCount, 0);
  if (total === 0) return { thoughts, stop: 'The pool has no eligible questions for any requested section.' };
  thoughts.push(`Plan: ${sections.map((s) => `${s.key}×${s.questionCount}`).join(', ')} — ${plural(total, 'question')}.`);
  return { thoughts, vars: { sections, shortfalls } };
}

const input$ = z.object({
  domainSlug: z.string().trim().min(1, 'Select a domain'),
  paperName: z.string().trim().min(3).max(120),
  durationMinutes: z.coerce.number().int().min(5).max(300).default(45),
  sectionPlan: z.string().trim().min(3).max(500).default('A:10, B:5'),
  negativeMarking: z.boolean().default(false),
  autoFit: z.boolean().default(true),
  activate: z.boolean().default(true),
});

export const paperAssemblyWorkflow: WorkflowDefinition = {
  id: 'paper-assembly',
  title: 'Question Paper Assembly & Readiness Check',
  category: 'Authoring Engine',
  goal: 'Check pool depth for a domain, assemble a multi-section paper that fits it, prove it is drawable, and activate it for the drive.',
  description: 'Reads the domain and its eligible question pool, fits your section plan to it, creates an inactive paper, runs a dry-run draw, then asks before activating.',
  risk: 'HIGH',
  estimatedSeconds: 20,
  roles: ['ADMIN'],
  notes: ['Activation switches the paper every new candidate in the domain receives — it always needs your approval.'],
  inputs: [
    domainField('domainSlug', 'Domain', true),
    { key: 'paperName', label: 'Paper name', type: 'text', required: true, placeholder: 'e.g. Campus Drive Oct 2026 — AI/ML' },
    { key: 'durationMinutes', label: 'Duration (minutes)', type: 'number', default: 45, min: 5, max: 300 },
    { key: 'sectionPlan', label: 'Sections (KEY:COUNT)', type: 'text', default: 'A:10, B:5', help: 'Comma-separated, e.g. A:15, B:10, E:2. Keys match the question bank’s section tags.' },
    { key: 'negativeMarking', label: 'Negative marking', type: 'boolean', default: false },
    { key: 'autoFit', label: 'Reduce counts to the available pool', type: 'boolean', default: true },
    { key: 'activate', label: 'Activate when ready (asks first)', type: 'boolean', default: true },
  ],
  input: input$,
  steps: [
    toolStep({
      kind: 'tool',
      id: 'domains',
      title: 'Check domain',
      description: 'Confirm the domain exists and see its current active paper.',
      tool: 'list_domains',
      args: () => ({}),
      stopIf: (o, ctx) => {
        const d = (o.domains as DomainInfo[]).find((x) => x.slug === input(ctx, 'domainSlug'));
        return d ? (d.isActive ? null : `Domain ${d.name} is closed; reopen it in Admin → Domains first.`) : `Unknown domain "${input(ctx, 'domainSlug')}".`;
      },
      observe: (o, ctx) => {
        const d = (o.domains as DomainInfo[]).find((x) => x.slug === input(ctx, 'domainSlug'))!;
        return d.activePaper ? `Current active paper: "${d.activePaper.name}" (${d.activePaper.ready ? 'ready' : 'NOT ready'}).` : `${d.name} has no active paper yet.`;
      },
    }),
    toolStep({
      kind: 'tool',
      id: 'pool',
      title: 'Measure pool depth',
      description: 'Eligible questions per section (active, not archived, valid MCQs).',
      tool: 'get_question_pool',
      args: (ctx) => ({ domainSlug: input(ctx, 'domainSlug') }),
      stopIf: (o) => ((o as unknown as Pool).total === 0 ? 'This domain has no eligible questions. Import questions first.' : null),
    }),
    toolStep({
      kind: 'tool',
      id: 'sample',
      title: 'Sample the question bank',
      description: 'Spot-check what the pool contains (no answer keys are read).',
      tool: 'search_questions',
      args: (ctx) => ({ domainSlug: input(ctx, 'domainSlug'), limit: 5 }),
      observe: (o) => {
        const qs = o.questions as { section: string; type: string; difficulty: string }[];
        return qs.length ? `Sample: ${qs.map((q) => `${q.section}/${q.type}/${q.difficulty.toLowerCase()}`).join(', ')}` : undefined;
      },
    }),
    reasonStep({
      id: 'plan',
      title: 'Plan sections against the pool',
      description: 'Fit the requested counts to what can actually be drawn.',
      think: (ctx) => planSections(input(ctx, 'sectionPlan'), out<Pool>(ctx, 'pool'), input(ctx, 'autoFit')),
    }),
    toolStep({
      kind: 'tool',
      id: 'create',
      title: 'Create paper (inactive)',
      description: 'Students are unaffected until activation.',
      tool: 'create_paper',
      args: (ctx) => ({
        name: input(ctx, 'paperName'),
        domainSlug: input(ctx, 'domainSlug'),
        durationMinutes: input(ctx, 'durationMinutes'),
        negativeMarkingEnabled: input(ctx, 'negativeMarking'),
        sections: v<PlannedSection[]>(ctx, 'sections'),
      }),
    }),
    toolStep({
      kind: 'tool',
      id: 'validate',
      title: 'Validate readiness',
      description: 'Shortfall check plus a dry-run random draw, exactly like a student start.',
      tool: 'validate_paper_readiness',
      args: (ctx) => ({ paperId: out<PaperOut>(ctx, 'create').paper.id }),
      stopIf: (o) => (o.ready ? null : 'The paper was created but is not ready, so it was not activated. Fix the pool and re-check it in Admin → Question Papers.'),
    }),
    toolStep({
      kind: 'tool',
      id: 'activate',
      title: 'Activate paper',
      description: 'Every new candidate in the domain gets this paper from now on.',
      tool: 'activate_paper',
      when: (ctx) => (input<boolean>(ctx, 'activate') ? true : 'Activation not requested — the paper stays inactive'),
      args: (ctx) => ({ paperId: out<PaperOut>(ctx, 'create').paper.id }),
      approval: {
        prompt: (ctx) => `Activate "${input(ctx, 'paperName')}" for every new candidate in ${input(ctx, 'domainSlug')}?`,
        assessment: (ctx) => {
          const d = out<{ domains: DomainInfo[] }>(ctx, 'domains').domains.find((x) => x.slug === input(ctx, 'domainSlug'))!;
          const p = out<PaperOut>(ctx, 'create').paper;
          return [
            `New paper: ${plural(p.totalQuestions, 'question')} (${p.sections.map((s) => `${s.key}×${s.questionCount}`).join(', ')}), dry-run draw succeeded`,
            d.activePaper ? `This deactivates the current paper "${d.activePaper.name}" — candidates already in progress keep their questions` : 'No paper is active in this domain today',
            ...(v<string[]>(ctx, 'shortfalls').length ? [`Counts were reduced to fit the pool: ${v<string[]>(ctx, 'shortfalls').join('; ')}`] : []),
          ];
        },
      },
    }),
  ],
  summarize: (ctx, o) => {
    const created = ctx.outputs.create as PaperOut | undefined;
    const activated = ctx.outputs.activate as { paper: { name: string }; deactivated: { name: string }[] } | null | undefined;
    if (!created) return { headline: o.stopReason ?? 'No paper was created', highlights: [], nextActions: ['Review the question pool in Admin → Question Bank.'] };
    const highlights = [
      { label: 'Paper', value: created.paper.name },
      { label: 'Paper ID', value: created.paper.id, copyable: true },
      { label: 'Questions', value: String(created.paper.totalQuestions) },
      { label: 'Status', value: activated ? 'ACTIVE' : 'Inactive', tone: activated ? ('success' as const) : ('info' as const) },
    ];
    if (activated) {
      return {
        headline: `"${created.paper.name}" is live for new candidates`,
        highlights: [...highlights, ...(activated.deactivated.length ? [{ label: 'Deactivated', value: activated.deactivated.map((d) => d.name).join(', ') }] : [])],
        nextActions: ['Run one dummy candidate through the full flow before the drive.', 'Re-check readiness after any question-bank changes.'],
      };
    }
    return {
      headline: o.status === 'rejected' ? `Paper created but activation was declined` : (o.stopReason ?? `Paper "${created.paper.name}" created (inactive)`),
      highlights,
      nextActions: ['Activate it later from Admin → Question Papers, or run this workflow again.'],
    };
  },
};
