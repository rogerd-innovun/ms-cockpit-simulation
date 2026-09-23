import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from './lib/auth';
import { api } from './lib/api';
import { useTheme } from './lib/theme';
import { LoginPage } from './pages/LoginPage';
import { WorklistPage } from './pages/WorklistPage';
import { RecordPage } from './pages/RecordPage';

export default function App() {
  const { user, loading, logout } = useAuth();

  if (loading) return <div className="empty">Loading…</div>;
  if (!user) return <LoginPage />;

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-name">PO-to-SO Cockpit</span>
          <span className="brand-sub">S/4HANA</span>
        </Link>
        <div className="spacer" />
        <Health />
        <ThemeToggle />
        <span className="who">
          <b>{user.name}</b>
          <span className="role">{user.role.toLowerCase()}</span>
        </span>
        <button className="quiet sm" onClick={logout}>Sign out</button>
      </header>
      <main className="page">
        <Routes>
          <Route path="/" element={<WorklistPage />} />
          <Route path="/records/:id" element={<RecordPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button className="quiet sm" onClick={toggle} title={`Switch to the ${next} sheet`} aria-label={`Switch to the ${next} sheet`}>
      {theme === 'dark' ? 'Light' : 'Dark'}
    </button>
  );
}

/** NFR-5.1 — the integration folders fail silently, so the chrome says so. */
function Health() {
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 15000 });
  if (!health.data) return null;

  const failed = Object.entries(health.data.checks).filter(([, v]) => !v.ok);
  if (failed.length === 0) {
    return (
      <span className="state t-ok" title="Database and both integration folders are reachable">
        <span className="lamp" aria-hidden="true" />
        <span className="cap">integration ok</span>
      </span>
    );
  }
  return (
    <span className="state t-crit" role="status" title={failed.map(([k, v]) => `${k}: ${v.error}`).join('\n')}>
      <span className="lamp" aria-hidden="true" />
      {failed.length} check{failed.length === 1 ? '' : 's'} failing
    </span>
  );
}
