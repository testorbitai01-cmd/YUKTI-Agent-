/**
 * API contract shared by the YUKTI server and UI (types only — no runtime code).
 */

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
/** read = no side effects · write = changes Test Orbit data · critical = affects candidates directly. */
export type ToolRisk = 'read' | 'write' | 'critical';
export type ServiceKey = 'questions' | 'candidates' | 'proctoring' | 'analytics';
export type OperatorRole = 'ADMIN' | 'REVIEWER';

export interface OperatorView {
  name: string;
  email: string;
  role: OperatorRole;
}

/** A form field for workflow inputs or for arguments a human can edit at an approval gate. */
export interface InputFieldDef {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'domain';
  required?: boolean;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  placeholder?: string;
  help?: string;
}

export interface WorkflowStepSummary {
  id: string;
  title: string;
  description: string;
  kind: 'tool' | 'reason';
  tool?: string;
  service?: ServiceKey;
  risk: ToolRisk;
  requiresApproval: boolean;
  /** Runs once per item (e.g. per coding answer). */
  forEach: boolean;
  /** Runs only when the agent's earlier findings call for it. */
  conditional: boolean;
}

export interface WorkflowSummary {
  id: string;
  title: string;
  category: string;
  goal: string;
  description: string;
  risk: RiskLevel;
  estimatedSeconds: number;
  inputs: InputFieldDef[];
  steps: WorkflowStepSummary[];
  /** Roles allowed to launch (Test Orbit also enforces roles on every tool call). */
  roles: OperatorRole[];
  /** Honest notes, e.g. capabilities from the original brief that Test Orbit does not have. */
  notes: string[];
  availability: { ready: boolean; missingTools: string[]; reason?: string };
}

export type RunStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled' | 'rejected';
export type StepStatus = 'pending' | 'running' | 'awaiting_approval' | 'succeeded' | 'failed' | 'skipped' | 'rejected';

export interface StepItemState {
  key: string;
  label: string;
  status: StepStatus;
  latencyMs?: number;
  error?: string;
}

export interface StepState {
  id: string;
  title: string;
  kind: 'tool' | 'reason';
  tool?: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  latencyMs?: number;
  /** Why it was skipped / what the agent concluded. */
  note?: string;
  error?: string;
  items?: StepItemState[];
}

export interface PendingApproval {
  id: string;
  stepId: string;
  itemKey?: string;
  tool: string;
  title: string;
  risk: ToolRisk;
  prompt: string;
  /** The agent's evidence and reasoning shown to the human before they decide. */
  assessment: string[];
  /** Longer material the human must read, e.g. the question and the candidate's code. */
  details: { label: string; content: string; format: 'code' | 'text' }[];
  args: Record<string, unknown>;
  /** Arguments the human may change (validated again by the tool). */
  editableFields: InputFieldDef[];
  requestedAt: string;
  expiresAt: string;
}

export interface RunHighlight {
  label: string;
  value: string;
  tone?: 'success' | 'warn' | 'danger' | 'info';
  copyable?: boolean;
}

export interface RunArtifactInfo {
  id: string;
  name: string;
  contentType: string;
  bytes: number;
}

export interface RunSummary {
  outcome: 'success' | 'partial' | 'stopped';
  headline: string;
  highlights: RunHighlight[];
  nextActions: string[];
  toolsExecuted: number;
  totalLatencyMs: number;
  artifacts: RunArtifactInfo[];
}

export interface RunView {
  id: string;
  workflowId: string;
  workflowTitle: string;
  status: RunStatus;
  operator: OperatorView;
  inputs: Record<string, unknown>;
  steps: StepState[];
  progress: number;
  pendingApproval: PendingApproval | null;
  summary: RunSummary | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export type RunEventType =
  | 'run.started'
  | 'step.started'
  | 'rpc.request'
  | 'rpc.response'
  | 'agent.thought'
  | 'approval.requested'
  | 'approval.decided'
  | 'step.finished'
  | 'run.finished';

export interface RunEvent {
  seq: number;
  at: string;
  type: RunEventType;
  level: 'info' | 'success' | 'warn' | 'error' | 'debug';
  message: string;
  stepId?: string;
  itemKey?: string;
  latencyMs?: number;
  httpStatus?: number;
  data?: unknown;
}

export interface HealthView {
  status: 'ok' | 'degraded';
  version: string;
  testorbit: { url: string; reachable: boolean; latencyMs: number | null };
  mcp: { endpoint: string; tools: number; services: Record<ServiceKey, number> };
}

export interface ToolCatalogEntry {
  name: string;
  title: string;
  description: string;
  service: ServiceKey;
  risk: ToolRisk;
  requiresApproval: boolean;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
}

export interface ToolCatalog {
  services: Record<ServiceKey, { name: string; title: string }>;
  tools: ToolCatalogEntry[];
}

/** Result of trying a read-only tool from the catalogue (the raw MCP exchange). */
export interface ToolTryResult {
  kind: 'result' | 'protocol_error' | 'transport_error';
  isError?: boolean;
  text?: string;
  data?: Record<string, unknown>;
  message?: string;
  httpStatus: number;
  latencyMs: number;
  endpoint: string;
  request: unknown;
}

export interface ApiErrorBody {
  error: { code: string; message: string; fieldErrors?: Record<string, string> };
}
