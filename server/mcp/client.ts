/**
 * MCP client used by the agent engine: JSON-RPC 2.0 over HTTP to a YUKTI-compatible MCP server
 * (by default this process). Returns the raw request/response so the run console can show the exact
 * protocol exchange, with timing and HTTP status.
 */
import type { ServiceKey } from '../../common/types.js';
import { LATEST_PROTOCOL_VERSION } from './server.js';

const CALL_TIMEOUT_MS = 30_000;

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  _meta?: Record<string, unknown>;
}

export interface McpExchange {
  request: { jsonrpc: '2.0'; id: number; method: string; params?: unknown };
  endpoint: string;
  httpStatus: number;
  latencyMs: number;
}

export type McpCallOutcome =
  | (McpExchange & { kind: 'result'; isError: boolean; text: string; data: Record<string, unknown>; resources: { uri: string; name: string; mimeType: string; text: string }[] })
  | (McpExchange & { kind: 'protocol_error'; code: number; message: string })
  | (McpExchange & { kind: 'transport_error'; message: string });

let nextId = 1;

export class McpClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  endpoint(service?: ServiceKey): string {
    return `${this.baseUrl}/mcp${service ? `/${service}` : ''}`;
  }

  private async rpc(token: string, method: string, params: unknown, service?: ServiceKey, signal?: AbortSignal) {
    const request = { jsonrpc: '2.0' as const, id: nextId++, method, params };
    const endpoint = this.endpoint(service);
    const started = performance.now();
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
          'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION,
        },
        body: JSON.stringify(request),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const body = (await res.json().catch(() => null)) as { result?: unknown; error?: { code: number; message: string } } | null;
      return { request, endpoint, httpStatus: res.status, latencyMs: Math.round(performance.now() - started), body };
    } catch (e) {
      const name = (e as Error).name;
      const message = name === 'TimeoutError' ? `MCP call timed out after ${CALL_TIMEOUT_MS / 1000}s` : name === 'AbortError' ? 'Cancelled' : 'MCP server unreachable';
      return { request, endpoint, httpStatus: 0, latencyMs: Math.round(performance.now() - started), body: null, transportError: message };
    }
  }

  async listTools(token: string, service?: ServiceKey): Promise<McpToolInfo[]> {
    const r = await this.rpc(token, 'tools/list', {}, service);
    const tools = (r.body?.result as { tools?: McpToolInfo[] } | undefined)?.tools;
    if (!tools) throw new Error(r.body?.error?.message ?? ('transportError' in r ? r.transportError : `MCP tools/list failed (HTTP ${r.httpStatus})`));
    return tools;
  }

  async callTool(token: string, service: ServiceKey, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallOutcome> {
    const r = await this.rpc(token, 'tools/call', { name, arguments: args }, service, signal);
    const base: McpExchange = { request: r.request, endpoint: r.endpoint, httpStatus: r.httpStatus, latencyMs: r.latencyMs };
    if ('transportError' in r) return { ...base, kind: 'transport_error', message: r.transportError! };
    if (!r.body) return { ...base, kind: 'transport_error', message: `MCP server returned HTTP ${r.httpStatus} without a JSON-RPC body` };
    if (r.body.error) return { ...base, kind: 'protocol_error', code: r.body.error.code, message: r.body.error.message };
    const result = (r.body.result ?? {}) as {
      isError?: boolean;
      content?: { type: string; text?: string; resource?: { uri: string; name?: string; mimeType?: string; text?: string } }[];
      structuredContent?: Record<string, unknown>;
    };
    const content = result.content ?? [];
    return {
      ...base,
      kind: 'result',
      isError: Boolean(result.isError),
      text: content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n'),
      data: result.structuredContent ?? {},
      resources: content
        .filter((c) => c.type === 'resource' && c.resource?.text !== undefined)
        .map((c) => ({ uri: c.resource!.uri, name: c.resource!.name ?? c.resource!.uri.split('/').pop() ?? 'resource', mimeType: c.resource!.mimeType ?? 'text/plain', text: c.resource!.text! })),
    };
  }

  /** Unauthenticated GET live check of the MCP endpoint. */
  async probe(): Promise<{ ok: boolean; tools: number; latencyMs: number | null }> {
    const started = performance.now();
    try {
      const res = await this.fetchImpl(this.endpoint(), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
      const body = (await res.json()) as { toolsCount?: number };
      return { ok: res.ok, tools: body.toolsCount ?? 0, latencyMs: Math.round(performance.now() - started) };
    } catch {
      return { ok: false, tools: 0, latencyMs: null };
    }
  }
}
