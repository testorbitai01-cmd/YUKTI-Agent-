/** Labels, tones and icons shared by every screen. */
import {
  AlertTriangle,
  BarChart3,
  Ban,
  Brain,
  CheckCircle2,
  Eye,
  FileStack,
  Hourglass,
  Loader2,
  Lock,
  ShieldAlert,
  Users,
  XCircle,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { RiskLevel, RunStatus, ServiceKey, ToolRisk, WorkflowStepSummary } from '../common/types';

export type Tone = 'neutral' | 'brand' | 'success' | 'warn' | 'danger' | 'violet' | 'dark';

export const RUN_STATUS: Record<RunStatus, { label: string; tone: Tone; icon: LucideIcon }> = {
  running: { label: 'Running', tone: 'brand', icon: Loader2 },
  awaiting_approval: { label: 'Awaiting approval', tone: 'warn', icon: Hourglass },
  completed: { label: 'Completed', tone: 'success', icon: CheckCircle2 },
  failed: { label: 'Failed', tone: 'danger', icon: XCircle },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: Ban },
  rejected: { label: 'Stopped — rejected', tone: 'warn', icon: AlertTriangle },
};

export const RISK: Record<RiskLevel, { label: string; tone: Tone }> = {
  LOW: { label: 'Low risk', tone: 'success' },
  MEDIUM: { label: 'Medium risk', tone: 'warn' },
  HIGH: { label: 'High risk', tone: 'danger' },
};

export const TOOL_RISK: Record<ToolRisk, { label: string; tone: Tone }> = {
  read: { label: 'Read-only', tone: 'success' },
  write: { label: 'Writes data', tone: 'warn' },
  critical: { label: 'Destructive', tone: 'danger' },
};

export const SERVICE: Record<ServiceKey, { label: string; icon: LucideIcon }> = {
  questions: { label: 'Questions & papers', icon: FileStack },
  candidates: { label: 'Candidates', icon: Users },
  proctoring: { label: 'Proctoring & re-entry', icon: ShieldAlert },
  analytics: { label: 'Evaluation & analytics', icon: BarChart3 },
};

/** How a step reads in the agent loop: observe (read tool), reason, act (write), or gated act. */
export type StepKind = 'observe' | 'reason' | 'act' | 'gate';
export function stepKind(s: Pick<WorkflowStepSummary, 'kind' | 'risk' | 'requiresApproval'>): StepKind {
  if (s.kind === 'reason') return 'reason';
  if (s.requiresApproval) return 'gate';
  return s.risk === 'read' ? 'observe' : 'act';
}

export const STEP_KIND: Record<StepKind, { label: string; icon: LucideIcon }> = {
  observe: { label: 'Observe', icon: Eye },
  reason: { label: 'Reason', icon: Brain },
  act: { label: 'Act', icon: Zap },
  gate: { label: 'Approval gate', icon: Lock },
};

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

export function fmtAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
