import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { HealthView, OperatorView, RunView, WorkflowSummary } from '../common/types';
import { ApiError, api } from './api';
import { AgenticExecutionStudio } from './components/AgenticExecutionStudio';
import { ApprovalsPage } from './components/ApprovalsPage';
import { Sidebar, Topbar } from './components/Header';
import { LoginScreen } from './components/LoginScreen';
import { RunsPage } from './components/RunsPage';
import { ToolsPage } from './components/ToolsPage';
import { WorkflowCardsGrid } from './components/WorkflowCardsGrid';
import { useRoute } from './router';

type Theme = 'dark' | 'light';

function storedTheme(): Theme {
  try {
    return localStorage.getItem('yukti-theme') === 'dark' ? 'dark' : 'light'; // light = the Test Orbit admin look
  } catch {
    return 'light';
  }
}

/** Health is public and answers 503 (with a body) when Test Orbit is down, so read the body either way. */
async function fetchHealth(): Promise<HealthView | null> {
  try {
    return (await (await fetch('/api/health')).json()) as HealthView;
  } catch {
    return null;
  }
}

export function App() {
  const route = useRoute();
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [operator, setOperator] = useState<OperatorView | null | undefined>(undefined);
  const [health, setHealth] = useState<HealthView | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [workflowsError, setWorkflowsError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('yukti-theme', theme);
    } catch {
      /* private mode: the theme just isn't remembered */
    }
  }, [theme]);

  useEffect(() => {
    api<{ operator: OperatorView }>('GET', '/auth/me')
      .then((r) => setOperator(r.operator))
      .catch(() => setOperator(null));
    const poll = () => void fetchHealth().then(setHealth);
    poll();
    const t = setInterval(poll, 30_000);
    return () => clearInterval(t);
  }, []);

  const signedOut = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) setOperator(null);
  }, []);

  const loadWorkflows = useCallback(() => {
    api<{ workflows: WorkflowSummary[] }>('GET', '/workflows')
      .then((r) => {
        setWorkflows(r.workflows);
        setWorkflowsError(null);
      })
      .catch((e) => {
        signedOut(e);
        setWorkflowsError(e instanceof Error ? e.message : 'Could not load workflows');
      });
  }, [signedOut]);

  // Workflows: on sign-in and whenever the catalogue is opened (availability can change).
  useEffect(() => {
    if (operator && (route.name === 'workflows' || !workflows)) loadWorkflows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operator, route.name, loadWorkflows]);

  // Runs drive the sidebar counts and the Approvals inbox — refresh every few seconds.
  useEffect(() => {
    if (!operator) return;
    const poll = () =>
      void api<{ runs: RunView[] }>('GET', '/runs')
        .then((r) => setRuns(r.runs))
        .catch(signedOut);
    poll();
    const t = setInterval(poll, 4000);
    return () => clearInterval(t);
  }, [operator, signedOut, route]);

  const logout = async () => {
    await api('POST', '/auth/logout').catch(() => undefined);
    setOperator(null);
    window.location.hash = '#/workflows';
  };

  if (operator === undefined) {
    return (
      <div className="center">
        <Loader2 className="spin" /> Loading YUKTI…
      </div>
    );
  }
  if (operator === null) return <LoginScreen theme={theme} onSignedIn={setOperator} />;

  const pendingApprovals = runs.filter((r) => r.pendingApproval).length;
  const activeRuns = runs.filter((r) => !r.finishedAt).length;

  let page;
  switch (route.name) {
    case 'workflow':
      page = <AgenticExecutionStudio key={`wf:${route.id}`} workflows={workflows} operator={operator} workflowId={route.id} />;
      break;
    case 'run':
      page = <AgenticExecutionStudio key={`run:${route.id}`} workflows={workflows} operator={operator} runId={route.id} />;
      break;
    case 'runs':
      page = <RunsPage runs={runs} />;
      break;
    case 'approvals':
      page = <ApprovalsPage runs={runs} />;
      break;
    case 'tools':
      page = <ToolsPage />;
      break;
    default:
      page = <WorkflowCardsGrid workflows={workflows} error={workflowsError} operator={operator} runs={runs} />;
  }

  return (
    <>
      <Sidebar
        route={route}
        operator={operator}
        health={health}
        pendingApprovals={pendingApprovals}
        activeRuns={activeRuns}
        theme={theme}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        onLogout={logout}
      />
      <div className="main">
        <Topbar theme={theme} onMenu={() => setMenuOpen(true)} />
        <main className="content">{page}</main>
      </div>
    </>
  );
}
