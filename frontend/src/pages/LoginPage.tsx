import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';

const ACCOUNTS = [
  { email: 'clerk@cockpit.local', cando: 'uploads — cannot approve' },
  { email: 'approver@cockpit.local', cando: 'approves for SAP' },
  { email: 'ops@cockpit.local', cando: 'monitors failures' },
  { email: 'admin@cockpit.local', cando: 'administrator' },
];

/** It genuinely is a sequence, so it is numbered. */
const STEPS = [
  { what: 'A customer purchase order arrives as a PDF', how: 'upload' },
  { what: 'The model reads it, field by field', how: 'confidence per field' },
  { what: 'A person checks the reading and approves', how: 'separate approver', hot: true },
  { what: 'A CSV lands in the folder SAP watches', how: 'atomic write' },
  { what: 'SAP writes back the Sales Order number', how: 'matched on correlation id' },
];

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('clerk@cockpit.local');
  const [password, setPassword] = useState('cockpit123');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Check the API is running.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <aside className="login-left">
        <div className="brand">
          <span className="brand-name">PO-to-SO Cockpit</span>
          <span className="brand-sub">S/4HANA</span>
        </div>

        <div>
          <h1>
            A machine reads it. <em>A person signs it off.</em>
          </h1>
          <p className="lede">
            Five steps sit between a customer&rsquo;s purchase order and a Sales Order in S/4HANA.
            Step three is a human, and it is not optional — which is the whole reason this exists.
          </p>

          <ol className="steps">
            {STEPS.map((s, i) => (
              <li key={s.what} className={`step ${s.hot ? 'hot' : ''}`}>
                <span className="no">{String(i + 1).padStart(2, '0')}</span>
                <span className="what">{s.what}</span>
                <span className="how">{s.how}</span>
              </li>
            ))}
          </ol>
        </div>

        <p className="cap">Milestone 1 — the lifecycle runs end to end.</p>
      </aside>

      <div className="login-right">
        <form className="login-form" onSubmit={submit}>
          <h2>Sign in</h2>

          <div className="fieldrow" style={{ gridTemplateColumns: '1fr' }}>
            <div className="body">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="username"
              />
            </div>
          </div>
          <div className="fieldrow" style={{ gridTemplateColumns: '1fr' }}>
            <div className="body">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
          </div>

          {error && <div className="err" role="alert">{error}</div>}

          <button className="primary" type="submit" disabled={busy} style={{ width: '100%', marginTop: 16 }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="accounts">
            <p className="cap" style={{ marginBottom: 6 }}>
              Seeded accounts — password <span className="mono">cockpit123</span>. The clerk cannot
              approve their own uploads.
            </p>
            {ACCOUNTS.map((a) => (
              <button
                key={a.email}
                type="button"
                className="account"
                aria-pressed={email === a.email}
                onClick={() => setEmail(a.email)}
              >
                <span className="mail">{a.email}</span>
                <span className="cando">{a.cando}</span>
              </button>
            ))}
          </div>
        </form>
      </div>
    </div>
  );
}
