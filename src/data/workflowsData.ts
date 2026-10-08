/**
 * Presentation metadata for the workflow cards. The workflows themselves (steps, tools, gates) are
 * defined and executed on the server and fetched from /api/workflows — this file only styles them.
 */
import { BarChart3, ClipboardCheck, type LucideIcon, ShieldAlert, ShieldCheck, Sparkles, Workflow, Zap } from 'lucide-react';

export const WORKFLOW_ICONS: Record<string, LucideIcon> = {
  'reentry-outage': Zap,
  'paper-assembly': Sparkles,
  'evaluation-queue': ClipboardCheck,
  'candidate-audit': ShieldCheck,
  'incident-triage': ShieldAlert,
  'placement-analytics': BarChart3,
};

export const DEFAULT_ICON = Workflow;
export const workflowIcon = (id: string) => WORKFLOW_ICONS[id] ?? DEFAULT_ICON;

/** Card filter order. */
export const CATEGORIES = ['Proctoring Ops', 'Authoring Engine', 'Evaluation Queue', 'Onboarding', 'Analytics'] as const;

export const fmtEstimate = (s: number) => (s < 60 ? `~${s}s` : `~${Math.round(s / 60)} min`);
