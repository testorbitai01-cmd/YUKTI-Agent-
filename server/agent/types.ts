/**
 * Workflow definition DSL.
 *
 * A workflow is a fixed plan of steps. The agent observes (read tools), reasons (pure, deterministic
 * `reason` steps that turn evidence into findings and decisions), and acts (write tools). Data flows
 * between steps through the run context. Any tool the registry marks `requiresApproval` pauses for a
 * human decision — the engine enforces this; a workflow cannot opt out.
 */
import type { z } from 'zod';
import type { InputFieldDef, OperatorRole, OperatorView, RiskLevel, RunHighlight } from '../../common/types.js';

export interface RunContext {
  readonly inputs: Record<string, unknown>;
  /** Tool step outputs by step id (structuredContent). For `forEach` steps: one entry per item, in order. */
  readonly outputs: Record<string, unknown>;
  /** Findings and decisions set by reason steps. */
  readonly vars: Record<string, unknown>;
  readonly operator: OperatorView;
}

/** `true` = run; a string = skip, with this reason shown to the operator. */
export type StepCondition = (ctx: RunContext) => true | string;

export interface ForEachSpec<I = unknown> {
  items: (ctx: RunContext) => I[];
  key: (item: I) => string;
  label: (item: I) => string;
}

export interface ApprovalSpec<I = unknown> {
  prompt?: (ctx: RunContext, args: Record<string, unknown>, item?: I) => string;
  assessment?: (ctx: RunContext, item?: I) => string[];
  details?: (ctx: RunContext, item?: I) => { label: string; content: string; format: 'code' | 'text' }[];
  /** Arguments the human may edit before approving (validated again by the tool). */
  editable?: InputFieldDef[] | ((ctx: RunContext, item?: I) => InputFieldDef[]);
}

export interface ToolStep<I = unknown> {
  kind: 'tool';
  id: string;
  title: string;
  description: string;
  tool: string;
  when?: StepCondition;
  args: (ctx: RunContext, item?: I) => Record<string, unknown>;
  forEach?: ForEachSpec<I>;
  approval?: ApprovalSpec<I>;
  /** Agent commentary on the result (shown in the console). */
  observe?: (output: Record<string, unknown>, ctx: RunContext, item?: I) => string | string[] | undefined;
  /** End the run gracefully (not a failure) when the result means there is nothing more to do. */
  stopIf?: (output: Record<string, unknown>, ctx: RunContext) => string | null;
  /** A failure here is recorded but does not fail the run. */
  optional?: boolean;
}

export interface ReasonResult {
  thoughts: string[];
  vars?: Record<string, unknown>;
  /** End the run gracefully with this explanation. */
  stop?: string;
}

export interface ReasonStep {
  kind: 'reason';
  id: string;
  title: string;
  description: string;
  when?: StepCondition;
  think: (ctx: RunContext) => ReasonResult;
}

export type StepDef = ToolStep<never> | ReasonStep;

export interface SummaryDraft {
  headline: string;
  highlights: RunHighlight[];
  nextActions: string[];
}

export interface WorkflowDefinition {
  id: string;
  title: string;
  category: string;
  goal: string;
  description: string;
  risk: RiskLevel;
  estimatedSeconds: number;
  roles: OperatorRole[];
  notes: string[];
  inputs: InputFieldDef[];
  input: z.ZodType<Record<string, unknown>>;
  steps: StepDef[];
  summarize: (ctx: RunContext, outcome: { status: 'completed' | 'stopped' | 'rejected' | 'failed' | 'cancelled'; stopReason?: string }) => SummaryDraft;
}

/** Typed helper: lets each step declare its own item type while the workflow keeps one step list. */
export function toolStep<I = never>(step: ToolStep<I>): StepDef {
  return step as unknown as StepDef;
}

export function reasonStep(step: Omit<ReasonStep, 'kind'>): StepDef {
  return { kind: 'reason', ...step };
}
