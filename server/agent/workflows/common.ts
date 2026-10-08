import type { InputFieldDef } from '../../../common/types.js';
import type { ReasonResult, RunContext } from '../types.js';

export interface StudentRef {
  id: string;
  fullName: string;
  mobileNumber: string;
  collegeName: string;
}

export const out = <T>(ctx: RunContext, stepId: string): T => ctx.outputs[stepId] as T;
export const v = <T>(ctx: RunContext, key: string): T => ctx.vars[key] as T;
export const input = <T>(ctx: RunContext, key: string): T => ctx.inputs[key] as T;

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 min';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m ? `${m} min${s ? ` ${s} s` : ''}` : `${s} s`;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Resolve exactly one student from a search, or stop with a precise explanation. */
export function pickOneStudent(students: StudentRef[], query: string): ReasonResult {
  if (students.length === 0) {
    return { thoughts: [`No student matches "${query}".`], stop: `No student matches "${query}". Check the registration number or name.` };
  }
  if (students.length > 1) {
    const list = students.slice(0, 5).map((s) => `${s.fullName} (${s.mobileNumber}, ${s.collegeName})`).join('; ');
    return {
      thoughts: [`"${query}" matches ${students.length} students: ${list}.`, 'Acting on the wrong candidate would be worse than stopping, so I will not guess.'],
      stop: `"${query}" matches ${students.length} students. Use the full registration number to identify exactly one.`,
    };
  }
  const s = students[0]!;
  return { thoughts: [`Identified ${s.fullName} (${s.collegeName}).`], vars: { student: s } };
}

export const domainField = (key: string, label: string, required: boolean, help?: string): InputFieldDef => ({ key, label, type: 'domain', required, help });

export const candidateField: InputFieldDef = {
  key: 'candidate',
  label: 'Candidate',
  type: 'text',
  required: true,
  placeholder: 'Registration number, name or mobile',
  help: 'A full registration number identifies exactly one candidate.',
};
