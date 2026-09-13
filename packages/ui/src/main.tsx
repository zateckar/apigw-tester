import { useState, type FormEvent, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./styles.css";

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      // each query picks its own cadence in App.tsx — a single global interval
      // polled the expensive long-window summaries as hard as the cheap ones
      retry: 1,
      staleTime: 3000
    }
  }
});

const CREDS_KEY = "apigw-basic-creds";

export function getCreds(): string | null {
  return sessionStorage.getItem(CREDS_KEY);
}

export function setCreds(headerValue: string | null): void {
  if (headerValue === null) sessionStorage.removeItem(CREDS_KEY);
  else sessionStorage.setItem(CREDS_KEY, headerValue);
}

function LoginGate() {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function tryAuth(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const tok = `Basic ${btoa(`${user}:${pass}`)}`;
      const r = await fetch("/api/summary", { headers: { authorization: tok } });
      if (r.status === 401) {
        setErr("Invalid username or password.");
        return;
      }
      if (!r.ok) {
        setErr(`Server ${r.status} — try again.`);
        return;
      }
      setCreds(tok);
      // reload once so every query hook starts authorized
      window.location.reload();
    } catch {
      // a network failure used to fall through the try/finally with no message
      setErr("Cannot reach the server. Check that it is running and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={(e) => void tryAuth(e)}>
        <h1>API GW Tester</h1>
        <p className="hint">Sign in to continue</p>
        <label htmlFor="login-user">Name</label>
        <input id="login-user" value={user} onChange={(e) => setUser(e.target.value)} required autoFocus autoComplete="username" />
        <label htmlFor="login-pass">Password</label>
        <input id="login-pass" value={pass} type="password" onChange={(e) => setPass(e.target.value)} required autoComplete="current-password" />
        {err && <div className="login-err" role="alert">{err}</div>}
        <button type="submit" className="primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="hint" style={{ marginTop: 12 }}>
          Credentials are stored in this browser tab only (sessionStorage) and sent as `Authorization: Basic …`.
        </p>
      </form>
    </div>
  );
}

function Root() {
  const [hasCreds, setHasCreds] = useState(() => getCreds() !== null);
  useEffect(() => {
    if (!hasCreds) return;
    const t = setInterval(() => { if (getCreds() === null) setHasCreds(false); }, 2000);
    return () => clearInterval(t);
  }, [hasCreds]);

  if (!hasCreds) return <LoginGate />;
  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={qc}>
    <Root />
  </QueryClientProvider>
);
