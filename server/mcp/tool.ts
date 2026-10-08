/**
 * MCP tool definitions. Each tool validates its input with Zod (the JSON Schema published in
 * tools/list is generated from the same schema) and calls the real Test Orbit admin API.
 */
import { z } from 'zod';
import type { OperatorView, ServiceKey, ToolRisk } from '../../common/types.js';
import type { TestOrbitClient, TestOrbitCredential } from '../testorbit/client.js';

export interface ToolContext {
  api: TestOrbitClient;
  credential: TestOrbitCredential;
  operator: OperatorView;
  signal?: AbortSignal;
}

/** An embedded MCP resource returned alongside the result (e.g. a CSV export). */
export interface ToolResource {
  uri: string;
  name: string;
  mimeType: string;
  text: string;
}

export interface ToolResult {
  /** One-line, human-readable outcome (MCP text content). */
  summary: string;
  /** Structured output (MCP structuredContent) consumed by the agent engine. */
  data: Record<string, unknown>;
  resources?: ToolResource[];
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  service: ServiceKey;
  description: string;
  risk: ToolRisk;
  /** Enforced by the agent engine for every run, regardless of the workflow definition. */
  requiresApproval: boolean;
  /** Safe to repeat with the same arguments (read tools; used for automatic retry decisions). */
  idempotent: boolean;
  input: S;
  handler(args: z.output<S>, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/** MCP tool descriptor for tools/list (2025-06-18: title + annotations). */
export function describeTool(t: ToolDef) {
  const schema = z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete schema.$schema;
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: schema,
    annotations: {
      title: t.title,
      readOnlyHint: t.risk === 'read',
      destructiveHint: t.risk === 'critical',
      idempotentHint: t.idempotent,
      openWorldHint: false,
    },
    _meta: { 'yukti/service': t.service, 'yukti/risk': t.risk, 'yukti/requiresApproval': t.requiresApproval },
  };
}

// ── Shared input pieces (mirroring Test Orbit's own limits; Test Orbit re-validates everything) ──
export const id = (what: string) => z.string().trim().min(1, `${what} is required`).max(64);
export const domainSlug = z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use a domain slug such as ai-ml').max(60);
export const reason = z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(1000);
export const limit = (max: number, def: number) => z.coerce.number().int().min(1).max(max).default(def);
export const isoDate = z.iso.date();

export const truncate = (s: string | null | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : (s ?? ''));
