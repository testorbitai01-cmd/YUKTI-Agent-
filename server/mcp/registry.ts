import type { ServiceKey } from '../../common/types.js';
import type { ToolDef } from './tool.js';
import { analyticsTools } from './tools/analytics.js';
import { candidateTools } from './tools/candidates.js';
import { proctoringTools } from './tools/proctoring.js';
import { questionTools } from './tools/questions.js';

export const SERVICES: Record<ServiceKey, { name: string; title: string }> = {
  questions: { name: 'testorbit-questions-mcp', title: 'Question bank & papers' },
  candidates: { name: 'testorbit-candidates-mcp', title: 'Candidates & onboarding' },
  proctoring: { name: 'testorbit-proctoring-mcp', title: 'Proctoring & re-entry' },
  analytics: { name: 'testorbit-analytics-mcp', title: 'Evaluation & analytics' },
};

export const ALL_TOOLS: readonly ToolDef[] = [...questionTools, ...candidateTools, ...proctoringTools, ...analyticsTools] as ToolDef[];

const byName = new Map(ALL_TOOLS.map((t) => [t.name, t]));
if (byName.size !== ALL_TOOLS.length) throw new Error('Duplicate MCP tool name in registry');

export function findTool(name: string): ToolDef | undefined {
  return byName.get(name);
}

export function toolsFor(service?: ServiceKey): ToolDef[] {
  return service ? ALL_TOOLS.filter((t) => t.service === service) : [...ALL_TOOLS];
}

export function isServiceKey(v: string): v is ServiceKey {
  return Object.hasOwn(SERVICES, v);
}
