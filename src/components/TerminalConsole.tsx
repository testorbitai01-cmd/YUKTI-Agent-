import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { RunEvent } from '../../common/types';

type Filter = 'all' | 'rpc' | 'agent' | 'errors';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'rpc', label: 'JSON-RPC' },
  { key: 'agent', label: 'Agent' },
  { key: 'errors', label: 'Warnings & errors' },
];

const matches = (e: RunEvent, f: Filter) =>
  f === 'all' || (f === 'rpc' ? e.type.startsWith('rpc.') : f === 'agent' ? e.type === 'agent.thought' || e.type.startsWith('approval.') : e.level === 'error' || e.level === 'warn');

const time = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleTimeString('en-GB', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

function Line({ e }: { e: RunEvent }) {
  const [open, setOpen] = useState(e.type === 'rpc.response' && e.level === 'error');
  const thought = e.type === 'agent.thought' && e.level === 'info';
  return (
    <div className="term-line">
      <span className="term-time">{time(e.at)}</span>
      <div>
        <span className={`term-msg ${thought ? 'lv-thought' : `lv-${e.level}`}`}>
          {thought ? '› ' : ''}
          {e.message}
        </span>
        {(e.httpStatus !== undefined || e.latencyMs !== undefined) && (
          <span className="term-meta">
            {e.httpStatus !== undefined ? `HTTP ${e.httpStatus || '—'}` : ''}
            {e.latencyMs !== undefined ? ` · latencyMs=${e.latencyMs}` : ''}
          </span>
        )}
        {e.data !== undefined && (
          <button className="term-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? '▾ hide' : '▸ payload'}
          </button>
        )}
        {open && e.data !== undefined && <pre className="term-json">{JSON.stringify(e.data, null, 2)}</pre>}
      </div>
    </div>
  );
}

/** Raw execution log: every JSON-RPC request/response with HTTP status and latency. */
export function TerminalConsole({ events, connected, finished }: { events: RunEvent[]; connected: boolean; finished: boolean }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [copied, setCopied] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const shown = useMemo(() => events.filter((e) => matches(e, filter)), [events, filter]);

  useEffect(() => {
    if (stick.current && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [shown.length]);

  const copy = () => {
    void navigator.clipboard?.writeText(events.map((e) => `${e.at} [${e.type}] ${e.message}${e.data !== undefined ? `\n${JSON.stringify(e.data, null, 2)}` : ''}`).join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="terminal" aria-label="Execution console">
      <div className="term-bar">
        <span className="lights" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span>yukti://run · {finished ? 'finished' : connected ? 'streaming live' : 'reconnecting…'}</span>
        <span className="grow" />
        {FILTERS.map((f) => (
          <button key={f.key} className="term-filter" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
        <button className="term-filter" onClick={copy} aria-label="Copy the full log">
          {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div
        className="term-body"
        ref={body}
        role="log"
        onScroll={(ev) => {
          const el = ev.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {shown.length === 0 ? <div className="term-empty">{events.length ? 'No lines match this filter.' : 'Waiting for the agent…'}</div> : shown.map((e) => <Line key={e.seq} e={e} />)}
      </div>
    </div>
  );
}
