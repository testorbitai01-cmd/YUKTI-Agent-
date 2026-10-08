import { z } from 'zod';
import { TestOrbitError } from '../../testorbit/client.js';
import type { DomainView, Paged, PaperView } from '../../testorbit/types.js';
import { defineTool, domainSlug, id, limit, truncate, type ToolContext } from '../tool.js';

const sectionKey = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,8}$/, 'Section must be 1–8 letters or digits (e.g. A, SQL1)');
const sectionInput = z.object({
  key: sectionKey,
  title: z.string().trim().min(1).max(80),
  questionCount: z.coerce.number().int().min(0).max(200),
  marksPerQuestion: z.coerce.number().min(0).max(100).nullable().optional().describe('Override marks for every question in the section (null = use each question’s marks)'),
  negativeMarksPerQuestion: z.coerce.number().min(0).max(100).nullable().optional(),
});
const sectionsInput = z.array(sectionInput).min(1).max(50);

type SectionInput = z.output<typeof sectionInput>;
const sectionPayload = (sections: SectionInput[]) =>
  sections.map((s) => ({ ...s, marksPerQuestion: s.marksPerQuestion ?? null, negativeMarksPerQuestion: s.negativeMarksPerQuestion ?? null }));

function paperSummary(p: PaperView) {
  return {
    id: p.id,
    name: p.name,
    domain: p.domain,
    isActive: p.isActive,
    ready: p.ready,
    editable: p.editable,
    durationMinutes: p.durationMinutes,
    totalQuestions: p.totalQuestions,
    sections: p.sections.map((s) => ({ key: s.key, title: s.title, questionCount: s.questionCount, available: s.available })),
    shortfalls: p.shortfalls,
  };
}

const getPaper = (paperId: string, ctx: ToolContext) => ctx.api.json<PaperView>('GET', `/admin/papers/${encodeURIComponent(paperId)}`, ctx.credential, { signal: ctx.signal });

export const listDomains = defineTool({
  name: 'list_domains',
  title: 'List domains',
  service: 'questions',
  description: 'Assessment domains with their eligible question counts and active paper (and whether that paper is ready).',
  risk: 'read',
  requiresApproval: false,
  idempotent: true,
  input: z.object({}),
  async handler(_args, ctx) {
    const r = await ctx.api.json<{ items: DomainView[] }>('GET', '/admin/domains', ctx.credential, { signal: ctx.signal });
    return {
      summary: `${r.items.length} domain${r.items.length === 1 ? '' : 's'}`,
      data: {
        domains: r.items.map((d) => ({ slug: d.slug, name: d.name, isActive: d.isActive, students: d.students, mcqQuestions: d.mcqQuestions, codingQuestions: d.codingQuestions, activePaper: d.activePaper })),
      },
    };
  },
});

export const searchQuestions = defineTool({
  name: 'search_questions',
  title: 'Search question bank',
  service: 'questions',
  description: 'Search active questions by domain, section, type, difficulty or text. Answer keys and explanations are never returned.',
  risk: 'read',
  requiresApproval: false,
  idempotent: true,
  input: z.object({
    domainSlug: domainSlug.optional(),
    section: sectionKey.optional(),
    type: z.enum(['MCQ', 'CODING']).optional(),
    difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).optional(),
    search: z.string().trim().max(200).optional(),
    limit: limit(50, 10),
  }),
  async handler(args, ctx) {
    const r = await ctx.api.json<Paged<{ id: string; domain: { slug: string }; section: string; type: string; difficulty: string; text: string; isActive: boolean; marks: number }>>(
      'GET',
      '/admin/questions',
      ctx.credential,
      { query: { domain: args.domainSlug, section: args.section, type: args.type, difficulty: args.difficulty, search: args.search, active: 'true', pageSize: args.limit }, signal: ctx.signal },
    );
    return {
      summary: `${r.total} active question${r.total === 1 ? '' : 's'} match`,
      data: {
        total: r.total,
        questions: r.items.map((q) => ({ id: q.id, domain: q.domain.slug, section: q.section, type: q.type, difficulty: q.difficulty, marks: q.marks, text: truncate(q.text, 160) })),
      },
    };
  },
});

export const getQuestionPool = defineTool({
  name: 'get_question_pool',
  title: 'Get question pool depth',
  service: 'questions',
  description: 'Eligible (active, not archived) questions per section for a domain, split MCQ / coding — the exact pool a paper draws from.',
  risk: 'read',
  requiresApproval: false,
  idempotent: true,
  input: z.object({ domainSlug }),
  async handler(args, ctx) {
    const r = await ctx.api.json<{ pools: { domain: string; section: string; type: 'MCQ' | 'CODING'; count: number }[] }>('GET', '/admin/questions/pool-summary', ctx.credential, {
      signal: ctx.signal,
    });
    const sections: Record<string, { mcq: number; coding: number; total: number }> = {};
    for (const p of r.pools.filter((x) => x.domain === args.domainSlug)) {
      const s = (sections[p.section] ??= { mcq: 0, coding: 0, total: 0 });
      s[p.type === 'MCQ' ? 'mcq' : 'coding'] += p.count;
      s.total += p.count;
    }
    const total = Object.values(sections).reduce((n, s) => n + s.total, 0);
    return { summary: `${total} eligible question${total === 1 ? '' : 's'} in ${Object.keys(sections).length} section(s) of ${args.domainSlug}`, data: { domainSlug: args.domainSlug, total, sections } };
  },
});

export const createPaper = defineTool({
  name: 'create_paper',
  title: 'Create question paper',
  service: 'questions',
  description: 'Create an INACTIVE question paper for a domain. Test Orbit rejects section counts larger than the eligible pool. Students are unaffected until it is activated.',
  risk: 'write',
  requiresApproval: false,
  idempotent: false,
  input: z.object({
    name: z.string().trim().min(3).max(120),
    domainSlug,
    description: z.string().trim().max(2000).optional(),
    durationMinutes: z.coerce.number().int().min(5).max(300).default(45),
    negativeMarkingEnabled: z.boolean().default(false),
    shuffleOptions: z.boolean().default(true),
    sections: sectionsInput,
  }),
  async handler(args, ctx) {
    const p = await ctx.api.json<PaperView>('POST', '/admin/papers', ctx.credential, { body: { ...args, description: args.description ?? '', sections: sectionPayload(args.sections) }, signal: ctx.signal });
    return { summary: `Created inactive paper "${p.name}" (${p.totalQuestions} questions)`, data: { paper: paperSummary(p) } };
  },
});

export const configurePaperSections = defineTool({
  name: 'configure_paper_sections',
  title: 'Configure paper sections',
  service: 'questions',
  description: 'Replace the sections of an existing paper (only while no assessment is running on it). Name, duration and marking settings are kept.',
  risk: 'write',
  requiresApproval: false,
  idempotent: true,
  input: z.object({ paperId: id('paperId'), sections: sectionsInput }),
  async handler(args, ctx) {
    const current = await getPaper(args.paperId, ctx);
    const p = await ctx.api.json<PaperView>('PUT', `/admin/papers/${encodeURIComponent(args.paperId)}`, ctx.credential, {
      body: {
        name: current.name,
        description: current.description,
        domainSlug: current.domain.slug,
        durationMinutes: current.durationMinutes,
        shuffleOptions: current.shuffleOptions,
        negativeMarkingEnabled: current.negativeMarkingEnabled,
        sections: sectionPayload(args.sections),
      },
      signal: ctx.signal,
    });
    return { summary: `Sections updated: ${p.sections.map((s) => `${s.key}×${s.questionCount}`).join(', ')}`, data: { paper: paperSummary(p) } };
  },
});

export const validatePaperReadiness = defineTool({
  name: 'validate_paper_readiness',
  title: 'Validate paper readiness',
  service: 'questions',
  description: 'Check a paper against the live question pool (shortfalls per section) and perform a dry-run random draw exactly as a student start would.',
  risk: 'read',
  requiresApproval: false,
  idempotent: true,
  input: z.object({ paperId: id('paperId') }),
  async handler(args, ctx) {
    const p = await getPaper(args.paperId, ctx);
    let sampleDraw: { ok: boolean; questions: number; error?: string };
    try {
      const s = await ctx.api.json<{ questions: unknown[] }>('GET', `/admin/papers/${encodeURIComponent(args.paperId)}/sample`, ctx.credential, { signal: ctx.signal });
      sampleDraw = { ok: true, questions: s.questions.length };
    } catch (e) {
      if (!(e instanceof TestOrbitError) || e.status !== 422) throw e;
      sampleDraw = { ok: false, questions: 0, error: e.message };
    }
    const ready = p.ready && sampleDraw.ok;
    return {
      summary: ready ? `"${p.name}" is ready: ${p.totalQuestions} questions drawable` : `"${p.name}" is NOT ready: ${p.shortfalls.map((s) => `section ${s.section} needs ${s.required}, has ${s.available}`).join('; ') || sampleDraw.error}`,
      data: { ready, paper: paperSummary(p), sampleDraw },
    };
  },
});

export const activatePaper = defineTool({
  name: 'activate_paper',
  title: 'Activate paper',
  service: 'questions',
  description: 'Make a paper the active paper for its domain. Every student who starts from now on gets this paper; the previously active paper of the domain is deactivated.',
  risk: 'critical',
  requiresApproval: true,
  idempotent: true,
  input: z.object({ paperId: id('paperId') }),
  async handler(args, ctx) {
    const r = await ctx.api.json<{ paper: PaperView; deactivated: { id: string; name: string }[] }>('PATCH', `/admin/papers/${encodeURIComponent(args.paperId)}/active`, ctx.credential, {
      body: { isActive: true },
      signal: ctx.signal,
    });
    return {
      summary: `"${r.paper.name}" is now the active paper for ${r.paper.domain.name}${r.deactivated.length ? `; deactivated ${r.deactivated.map((d) => `"${d.name}"`).join(', ')}` : ''}`,
      data: { paper: paperSummary(r.paper), deactivated: r.deactivated },
    };
  },
});

export const questionTools = [listDomains, searchQuestions, getQuestionPool, createPaper, configurePaperSections, validatePaperReadiness, activatePaper];
