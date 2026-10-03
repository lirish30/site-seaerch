import { useState } from "react";
import { api, ApiError } from "../api";

export default function Login() {
  const [pw, setPw] = useState(""); const [err, setErr] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr("");
    try { await api.post("/login", { password: pw }); location.href = "/"; }
    catch (x) { setErr(x instanceof ApiError && x.status === 401 ? "Wrong password" : "Login failed"); }
  }
  return (
    <div className="shell" style={{ maxWidth: 360, marginTop: 80 }}>
      <form className="card" onSubmit={submit}>
        <h2>Site Search</h2>
        <label htmlFor="pw">Password</label>
        <input id="pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        {err && <p className="error">{err}</p>}
        <p><button className="primary" type="submit">Sign in</button></p>
      </form>
    </div>
  );
}
