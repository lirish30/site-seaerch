import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import Icon from "../components/Icon";
import { loginErrorText } from "../loginView";

/** Same 16px grid and stroke as the icon set; "eye-off" is only used here. */
const EyeOff = () => (
  <svg className="icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M6.6 3.3A6.6 6.6 0 0 1 8 3.1c3.3 0 5.6 2.6 6.4 4.9a8 8 0 0 1-1.7 2.6M4.4 4.9A8 8 0 0 0 1.6 8c.8 2.3 3.1 4.9 6.4 4.9 1 0 1.9-.2 2.7-.6M9.4 9.4a2 2 0 0 1-2.8-2.8M2 2l12 12" />
  </svg>
);

export default function Login() {
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => { const t = document.title; document.title = "Sign in · Site Search"; return () => { document.title = t; }; }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!pw) { setErr("Enter your password"); field.current?.focus(); return; }
    setErr(""); setBusy(true);
    try { await api.post("/login", { password: pw }); location.href = "/"; }
    catch (x) { setErr(loginErrorText(x instanceof ApiError ? x.status : undefined)); setBusy(false); field.current?.focus(); }
  }

  return (
    <main className="lg">
      <div className="lg-brand">
        <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true"><rect width="36" height="36" rx="10.08" fill="#17171a" /><rect x="6.6" y="16.6" width="13" height="2.9" rx="1" fill="#fff" /><circle cx="25.45" cy="17.95" r="3.95" fill="#ff5b23" /></svg>
        <span>Site Search</span>
      </div>
      <form className="lg-card" onSubmit={submit} noValidate>
        <div className="lg-head">
          <h1>Sign in</h1>
          <p>This is a private workspace.</p>
        </div>
        <div className="lg-field-group">
          <label htmlFor="lg-pw">Password</label>
          <div className={`lg-field${err ? " has-error" : ""}`}>
            <Icon name="key" size={15} className="lg-lead" />
            <input id="lg-pw" ref={field} type={show ? "text" : "password"} name="password" value={pw} autoComplete="current-password" autoFocus
              autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={err ? true : undefined} aria-describedby={err ? "lg-err" : undefined}
              onChange={(e) => { setPw(e.target.value); if (err) setErr(""); }} />
            <button type="button" className="lg-eye" aria-label={show ? "Hide password" : "Show password"} aria-pressed={show} onClick={() => setShow((s) => !s)}>
              {show ? <EyeOff /> : <Icon name="eye" size={15} />}
            </button>
          </div>
          {err && <p id="lg-err" className="lg-err" role="alert"><Icon name="alert" size={13} />{err}</p>}
        </div>
        <button type="submit" className="btn primary lg-submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <p className="lg-foot">Nothing is ever sent from Site Search. Drafts only.</p>
    </main>
  );
}
