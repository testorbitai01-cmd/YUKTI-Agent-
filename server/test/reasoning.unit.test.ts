import { describe, expect, it } from 'vitest';
import { auditEducation } from '../agent/workflows/candidateAudit.js';
import { scoreSession } from '../agent/workflows/incidentTriage.js';
import { parseSectionPlan, planSections } from '../agent/workflows/paperAssembly.js';
import { assessReentry } from '../agent/workflows/reentryOutage.js';
import { percentile, percentileRank } from '../mcp/tools/analytics.js';
import { extractAdminCookie } from '../testorbit/client.js';

describe('paper planning', () => {
  const pool = { total: 18, sections: { A: { mcq: 12, coding: 0, total: 12 }, B: { mcq: 4, coding: 0, total: 4 }, E: { mcq: 0, coding: 2, total: 2 } } };

  it('parses KEY:COUNT plans and rejects duplicates or junk', () => {
    expect(parseSectionPlan('a:10, B=5;E×2')).toEqual([
      { key: 'A', count: 10 },
      { key: 'B', count: 5 },
      { key: 'E', count: 2 },
    ]);
    expect(() => parseSectionPlan('A:1, A:2')).toThrow(/twice/);
    expect(() => parseSectionPlan('ten questions')).toThrow(/KEY:COUNT/);
  });

  it('fits counts to the pool when auto-fit is on', () => {
    const r = planSections('A:10, B:6, E:2', pool, true);
    expect(r.stop).toBeUndefined();
    expect(r.vars!.sections).toEqual([
      { key: 'A', title: 'Section A', questionCount: 10 },
      { key: 'B', title: 'Section B', questionCount: 4 },
      { key: 'E', title: 'Section E', questionCount: 2 },
    ]);
    expect(r.vars!.shortfalls).toEqual(['section B wants 6, pool has 4']);
  });

  it('stops before Test Orbit would reject the paper when auto-fit is off', () => {
    expect(planSections('A:20', pool, false).stop).toMatch(/Not enough eligible questions/);
    expect(planSections('Z:5', pool, true).stop).toMatch(/no eligible questions/);
  });
});

describe('re-entry assessment', () => {
  const req = { id: 'r', trigger: 'NETWORK_INTERRUPTION' as const, createdAt: '', student: { id: 's', fullName: 'A', mobileNumber: '', collegeName: '' }, session: { id: 'x', status: 'INTERRUPTED', statusLabel: 'Interrupted', remainingMs: 600_000, eventCount: 1, lastAnswerSavedAt: null } };
  const ev = (warnings: number, remainingMs = 600_000) => ({
    session: { status: 'INTERRUPTED', statusLabel: 'Interrupted', remainingMs, resumeCount: 0, terminationReason: null, answered: '5/10', lastHeartbeatAt: null },
    totals: { events: warnings, warnings, terminations: 0, byType: (warnings ? { TAB_HIDDEN: warnings } : {}) as Record<string, number> },
    events: [],
  });

  it('treats a clean network interruption as routine and a policy termination as needing judgement', () => {
    expect(assessReentry(req, ev(0), 5).verdict).toBe('routine');
    expect(assessReentry({ ...req, trigger: 'POLICY_TERMINATION' }, ev(0), 5).verdict).toBe('review');
    expect(assessReentry(req, ev(3), 5).verdict).toBe('review');
  });

  it('warns when the approval would leave no time (Test Orbit would refuse)', () => {
    expect(assessReentry(req, ev(0, 10_000), 0).lines.join(' ')).toMatch(/will refuse/);
  });
});

describe('incident severity', () => {
  it('weights identity signals above attention signals', () => {
    const s = scoreSession({ session: { id: 'x', status: 'IN_PROGRESS', statusLabel: '', answered: '' }, student: { fullName: 'A' }, totals: { events: 4, warnings: 2, terminations: 0, byType: { MULTIPLE_FACES_DETECTED: 2, WINDOW_BLUR: 2, NETWORK_OFFLINE: 5 } } });
    expect(s.score).toBe(7);
    expect(s.evidence).toHaveLength(2);
  });
});

describe('education audit', () => {
  const base = {
    student: { fullName: 'A', registrationNumber: 'R', yearOfPassing: 2026, domain: { slug: 'ai-ml', name: 'AI/ML' }, domainLockedAt: null, archivedAt: null, education: [] as never[] },
    photo: { available: true },
    sessions: [],
  };
  it('flags missing levels and broken chronology', () => {
    const r = auditEducation({
      ...base,
      student: {
        ...base.student,
        education: [
          { level: 'SSC', institutionName: 'S', yearOfCompletion: 2022, gradeType: 'PERCENTAGE', score: 90 },
          { level: 'UG', institutionName: 'U', yearOfCompletion: 2021, gradeType: 'CGPA_10', score: 8.5 },
        ] as never[],
      },
    });
    expect(r.flags).toEqual(expect.arrayContaining(['HSC record missing', 'UG (2021) is not after SSC (2022)']));
    expect(r.facts.join(' ')).toContain('≈ 85%');
  });
});

describe('percentiles', () => {
  it('uses nearest-rank percentiles and a ties-aware rank', () => {
    const s = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(s, 50)).toBe(50);
    expect(percentile(s, 90)).toBe(90);
    expect(percentileRank(s, 50)).toBe(45);
  });
});

describe('Test Orbit session cookie', () => {
  it('extracts only the admin cookie (dev or __Host- production name)', () => {
    expect(extractAdminCookie(['other=1; Path=/', 'to_admin=abc; Path=/; HttpOnly'])).toBe('to_admin=abc');
    expect(extractAdminCookie(['__Host-to_admin=xyz; Path=/; Secure'])).toBe('__Host-to_admin=xyz');
    expect(extractAdminCookie(['to_admin=; Max-Age=0'])).toBeNull();
  });
});
