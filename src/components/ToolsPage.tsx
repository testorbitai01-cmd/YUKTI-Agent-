import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Copy, Loader2, Lock, Play, RefreshCw, Search, ShieldOff, Wrench, X, XCircle } from 'lucide-react';
import type { ServiceKey, ToolCatalog, ToolCatalogEntry, ToolTryResult } from '../../common/types';
import { ApiError, api } from '../api';
import { SERVICE, TOOL_RISK } from '../status';
import { Badge, CardHeader, EmptyState, PageHeader } from './ui';

/** Example arguments from the JSON Schema: required keys only, with defaults where given. */
function exampleArgs(schema: Record<string, unknown>): string {
  const props = (schema.properties ?? {}) as Record<string, { type?: string; default?: unknown; enum?: unknown[] }>;
  const required = (schema.required ?? []) as string[];
  const out: Record<string, unknown> = {};
  for (const key of required) {
    const p = props[key] ?? {};
    out[key] = p.default ?? p.enum?.[0] ?? (p.type === 'number' || p.type === 'integer' ? 0 : p.type === 'boolean' ? false : '');
  }
  return JSON.stringify(out, null, 2);
}

function Inspector({ tool, onClose }: { tool: ToolCatalogEntry; onClose: () => void }) {
  const [args, setArgs] = useState(() => exampleArgs(tool.inputSchema));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ToolTryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tryable = tool.risk === 'read' && !tool.requiresApproval;
  const risk = TOOL_RISK[tool.risk];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async () => {
    setError(null);
    setResult(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(args || '{}') as Record<string, unknown>;
    } catch {
      setError('Arguments must be valid JSON');
      return;
    }
    setBusy(true);
    try {
      setResult((await api<{ result: ToolTryResult }>('POST', `/tools/${tool.name}/call`, { arguments: parsed })).result);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Call failed');
    } finally {
      setBusy(false);
    }
  };

  const ok = result?.kind === 'result' && !result.isError;
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="tool-title">
        <div className="drawer-head">
          <span className="icon-tile brand" aria-hidden>
            <Wrench size={18} />
          </span>
          <div className="grow">
            <h2 id="tool-title" className="tool-name" style={{ fontSize: 15 }}>
              {tool.name}
            </h2>
            <div className="muted" style={{ fontSize: 13 }}>
              {tool.title} · {SERVICE[tool.service].label}
            </div>
          </div>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="drawer-body">
          <p className="muted">{tool.description}</p>
          <div className="tool-tags">
            <Badge tone={risk.tone}>{risk.label}</Badge>
            {tool.requiresApproval && (
              <Badge tone="warn" icon={Lock}>
                Approval gate
              </Badge>
            )}
            <span className="chip">readOnlyHint: {String(tool.annotations.readOnlyHint)}</span>
            <span className="chip">destructiveHint: {String(tool.annotations.destructiveHint)}</span>
            <span className="chip">idempotentHint: {String(tool.annotations.idempotentHint)}</span>
          </div>
          <div>
            <div className="section-title">Endpoint</div>
            <code className="chip" style={{ fontSize: 12 }}>
              POST /mcp/{tool.service} · tools/call
            </code>
          </div>
          <div>
            <div className="section-title">Input schema</div>
            <pre className="code-block">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
          </div>
          {tryable ? (
            <div>
              <div className="section-title">Try it on live data (as you)</div>
              <textarea className="input mono" rows={6} value={args} onChange={(e) => setArgs(e.target.value)} aria-label="Arguments (JSON)" spellCheck={false} />
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn primary sm" onClick={run} disabled={busy}>
                  {busy ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Call tool
                </button>
                <button className="btn ghost sm" onClick={() => setArgs(exampleArgs(tool.inputSchema))}>
                  <RefreshCw size={14} /> Reset
                </button>
              </div>
            </div>
          ) : (
            <div className="alert warn">
              <ShieldOff size={16} />
              <span>This tool changes data{tool.risk === 'read' ? ' or exports personal data' : ''}, so it only runs inside a workflow, behind an approval gate.</span>
            </div>
          )}
          {error && <div className="alert error">{error}</div>}
          {result && (
            <div>
              <div className="row wrap" style={{ marginBottom: 8 }}>
                <Badge tone={ok ? 'success' : 'danger'} icon={ok ? CheckCircle2 : XCircle}>
                  {ok ? 'Success' : result.kind === 'result' ? 'Tool error' : 'Call failed'}
                </Badge>
                <span className="chip">HTTP {result.httpStatus || '—'}</span>
                <span className="chip">latencyMs={result.latencyMs}</span>
                <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={() => void navigator.clipboard?.writeText(JSON.stringify(result.data ?? result, null, 2))}>
                  <Copy size={13} /> Copy
                </button>
              </div>
              {(result.text || result.message) && <p style={{ marginBottom: 8 }}>{result.text ?? result.message}</p>}
              {result.data && <pre className="code-block">{JSON.stringify(result.data, null, 2)}</pre>}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

export function ToolsPage() {
  const [catalog, setCatalog] = useState<ToolCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<ToolCatalogEntry | null>(null);

  useEffect(() => {
    api<ToolCatalog>('GET', '/tools')
      .then(setCatalog)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load tools'));
  }, []);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const tools = (catalog?.tools ?? []).filter((t) => !q || `${t.name} ${t.title} ${t.description}`.toLowerCase().includes(q));
    return (Object.keys(SERVICE) as ServiceKey[]).map((s) => ({ service: s, tools: tools.filter((t) => t.service === s) })).filter((g) => g.tools.length);
  }, [catalog, query]);

  const counts = catalog ? { read: catalog.tools.filter((t) => t.risk === 'read').length, gated: catalog.tools.filter((t) => t.requiresApproval).length } : null;

  return (
    <>
      <PageHeader
        title="MCP tools"
        description="The Model Context Protocol tools YUKTI's agent uses. Each one calls the real Test Orbit admin API as the signed-in admin. Any MCP client can use them at /mcp with an operator bearer token."
        actions={
          <label className="search">
            <span className="sr-only">Search tools</span>
            <Search size={15} />
            <input className="input" placeholder="Search tools" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        }
      />
      {counts && (
        <div className="row wrap" style={{ marginBottom: 16 }}>
          <Badge tone="brand">{catalog!.tools.length} tools</Badge>
          <Badge tone="success">{counts.read} read-only</Badge>
          <Badge tone="warn" icon={Lock}>
            {counts.gated} behind approval gates
          </Badge>
          <span className="chip">protocol 2025-06-18 · streamable HTTP · JSON-RPC 2.0</span>
        </div>
      )}
      {error && <div className="alert error">{error}</div>}
      {!catalog && !error && <div className="center pulse">Loading tools…</div>}
      {catalog && !groups.length && (
        <div className="card">
          <EmptyState icon={Search} title="No tool matches" />
        </div>
      )}
      {groups.map(({ service, tools }) => {
        const S = SERVICE[service];
        return (
          <section key={service} className="card service">
            <CardHeader icon={S.icon} title={catalog!.services[service].title} description={<code>/mcp/{service}</code>} actions={<Badge>{tools.length} tools</Badge>} />
            <ul className="list">
              {tools.map((t) => {
                const risk = TOOL_RISK[t.risk];
                return (
                  <li key={t.name} className="tool-row">
                    <div style={{ minWidth: 0 }}>
                      <div className="tool-name">{t.name}</div>
                      <div className="tool-desc">{t.description}</div>
                      <div className="tool-tags">
                        <Badge tone={risk.tone}>{risk.label}</Badge>
                        {t.requiresApproval && (
                          <Badge tone="warn" icon={Lock}>
                            Approval gate
                          </Badge>
                        )}
                        {t.annotations.idempotentHint && <span className="chip">idempotent</span>}
                      </div>
                    </div>
                    <button className="btn secondary sm" onClick={() => setOpen(t)}>
                      {t.risk === 'read' && !t.requiresApproval ? <Play size={13} /> : <Search size={13} />} {t.risk === 'read' && !t.requiresApproval ? 'Try' : 'Inspect'}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {open && <Inspector tool={open} onClose={() => setOpen(null)} />}
    </>
  );
}
