/** App shell navigation, matching the Test Orbit admin sidebar (navy, brand-blue active item). */
import { Bot, History, LayoutGrid, LogOut, Menu, Moon, ShieldCheck, Sun, Wrench } from 'lucide-react';
import type { HealthView, OperatorView } from '../../common/types';
import { href, type Route } from '../router';

interface Props {
  route: Route;
  operator: OperatorView;
  health: HealthView | null;
  pendingApprovals: number;
  activeRuns: number;
  theme: 'dark' | 'light';
  open: boolean;
  onClose: () => void;
  onToggleTheme: () => void;
  onLogout: () => void;
}

const isActive = (route: Route, section: 'workflows' | 'runs' | 'approvals' | 'tools') =>
  section === 'workflows' ? route.name === 'workflows' || route.name === 'workflow' : section === 'runs' ? route.name === 'runs' || route.name === 'run' : route.name === section;

export function Sidebar({ route, operator, health, pendingApprovals, activeRuns, theme, open, onClose, onToggleTheme, onLogout }: Props) {
  const link = (section: 'workflows' | 'runs' | 'approvals' | 'tools', label: string, Icon: typeof Bot, count?: number) => (
    <li>
      <a className="nav-link" href={href({ name: section })} aria-current={isActive(route, section) ? 'page' : undefined} onClick={onClose}>
        <Icon size={16} />
        {label}
        {count ? (
          <span className="nav-count" aria-label={`${count} pending`}>
            {count}
          </span>
        ) : null}
      </a>
    </li>
  );
  const mcpOk = Boolean(health);
  const toOk = health?.testorbit.reachable ?? false;

  return (
    <>
      {open && <div className="drawer-backdrop" onClick={onClose} aria-hidden />}
      <aside className={`sidebar${open ? ' open' : ''}`} aria-label="YUKTI navigation">
        <div className="sidebar-brand">
          <img src="/logo-dark.png" alt="Test Orbit" />
        </div>
        <div className="product">
          <span className="product-mark" aria-hidden>
            <Bot size={17} />
          </span>
          <div>
            <b>YUKTI AGENT</b>
            <span>Agentic control center</span>
          </div>
        </div>
        <ul className="nav">
          <li className="nav-label">Operate</li>
          {link('workflows', 'Workflows', LayoutGrid)}
          {link('runs', 'Runs', History, activeRuns || undefined)}
          {link('approvals', 'Approvals', ShieldCheck, pendingApprovals || undefined)}
          <li className="nav-label">Platform</li>
          {link('tools', 'MCP tools', Wrench)}
        </ul>
        <div className="sys" aria-label="System status">
          <div className="sys-row">
            <span className={`dot ${mcpOk ? 'ok' : 'bad'}`} /> MCP server <span className="val">{mcpOk ? `${health!.mcp.tools} tools` : 'offline'}</span>
          </div>
          <div className="sys-row">
            <span className={`dot ${toOk ? 'ok' : 'bad'}`} /> Test Orbit API <span className="val">{toOk ? `${health!.testorbit.latencyMs} ms` : 'unreachable'}</span>
          </div>
        </div>
        <div className="account">
          <p>{operator.name}</p>
          <small>
            {operator.email} · {operator.role === 'ADMIN' ? 'Administrator' : 'Reviewer'}
          </small>
          <div className="account-actions">
            <button type="button" onClick={onToggleTheme}>
              {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />} {theme === 'dark' ? 'Light' : 'Dark'} mode
            </button>
            <button type="button" onClick={onLogout}>
              <LogOut size={15} /> Sign out
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

/** Mobile top bar (the sidebar becomes a drawer below 1024px). */
export function Topbar({ onMenu, theme }: { onMenu: () => void; theme: 'dark' | 'light' }) {
  return (
    <header className="topbar">
      <button className="btn ghost icon" onClick={onMenu} aria-label="Open menu">
        <Menu size={20} />
      </button>
      <img src={theme === 'dark' ? '/logo-dark.png' : '/logo.png'} alt="Test Orbit" />
      <span className="badge brand" style={{ marginLeft: 'auto' }}>
        <Bot size={12} /> YUKTI
      </span>
    </header>
  );
}
