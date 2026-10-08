import { useState, type FormEvent } from 'react';
import { Activity, KeyRound, Loader2, Lock, LogIn, Mail, ShieldCheck } from 'lucide-react';
import type { OperatorView } from '../../common/types';
import { ApiError, api } from '../api';

export function LoginScreen({ theme, onSignedIn }: { theme: 'dark' | 'light'; onSignedIn: (o: OperatorView) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ operator: OperatorView }>('POST', '/auth/login', { email, password });
      onSignedIn(r.operator);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <aside className="login-aside">
        <img src="/logo-dark.png" alt="Test Orbit" />
        <div style={{ position: 'relative', zIndex: 1 }}>
          <span className="badge dark" style={{ background: 'rgb(37 99 235 / 0.25)', marginBottom: 16 }}>
            YUKTI AGENT
          </span>
          <h2>Agentic operations for your recruitment drives.</h2>
          <ul>
            <li>
              <ShieldCheck size={18} /> Every action runs as you, through Test Orbit, and is recorded in its audit log.
            </li>
            <li>
              <Lock size={18} /> Steps that affect candidates wait for your approval — nothing high-risk runs on its own.
            </li>
            <li>
              <Activity size={18} /> Live, explainable execution: every tool call, result and decision is on screen.
            </li>
          </ul>
        </div>
        <small style={{ color: 'rgb(255 255 255 / 0.4)', position: 'relative', zIndex: 1 }}>Test Orbit · Orbiting every exam securely</small>
      </aside>

      <main className="login-main">
        <form className="card login-card form" onSubmit={submit}>
          <img src={theme === 'dark' ? '/logo-dark.png' : '/logo.png'} alt="" className="login-mobile-logo" />
          <div>
            <h1>Sign in to YUKTI</h1>
            <p className="lead">Use your Test Orbit admin account.</p>
          </div>
          <div className="field">
            <label htmlFor="email">Email</label>
            <div className="search">
              <Mail size={15} />
              <input id="email" className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@college.edu" style={{ minWidth: 0 }} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <div className="search">
              <KeyRound size={15} />
              <input id="password" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} style={{ minWidth: 0 }} />
            </div>
          </div>
          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
          <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? <Loader2 size={16} className="spin" /> : <LogIn size={16} />} {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="subtle" style={{ fontSize: 12, textAlign: 'center' }}>
            Forgot it? Run <code>npm run admin:reset-password</code> on the Test Orbit server.
          </p>
        </form>
      </main>
    </div>
  );
}
