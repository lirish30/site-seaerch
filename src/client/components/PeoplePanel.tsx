import { useState } from "react";
import { api } from "../api";
import type { Contact, Person } from "../types";

const blank = { name: "", role: "", email: "", phone: "", linkedin: "" };

/** Points of contact: people found on the site (one click to save) plus people added by hand. */
export default function PeoplePanel({ leadId, people, contacts, onChange, onError }: {
  leadId: string; people: Person[]; contacts: Contact[]; onChange: () => void; onError: (m: string) => void;
}) {
  const [form, setForm] = useState(blank);
  const [open, setOpen] = useState(false);
  const saved = new Set(people.map((p) => (p.email ?? "").toLowerCase()).filter(Boolean));
  const found = contacts.filter((c) => c.type === "email" && c.person_name && !saved.has(c.value.toLowerCase()));

  async function run(fn: () => Promise<unknown>) {
    try { await fn(); onChange(); } catch (e) { onError((e as Error).message); }
  }
  const add = (p: Partial<Person> & { name: string }) => run(() => api.post(`/leads/${leadId}/people`, p));
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    await add({ ...form, is_poc: people.length === 0 } as any);
    setForm(blank); setOpen(false);
  }

  return (
    <div className="people">
      <ul className="people-list">
        {people.map((p) => (
          <li key={p.id} className={p.is_poc ? "poc" : ""}>
            <div>
              <strong>{p.name}</strong>{p.role && <span className="muted"> · {p.role}</span>}
              {p.is_poc && <span className="tag poc-tag">POC</span>}
              <div className="person-meta">
                {p.email && <a href={`mailto:${p.email}`}>{p.email}</a>}
                {p.phone && <a href={`tel:${p.phone}`}>{p.phone}</a>}
                {p.linkedin && /^https?:\/\//.test(p.linkedin) && <a href={p.linkedin} target="_blank" rel="noreferrer">LinkedIn</a>}
              </div>
            </div>
            <div className="row">
              {!p.is_poc && <button className="link-btn" onClick={() => run(() => api.patch(`/leads/${leadId}/people/${p.id}`, { is_poc: true }))}>Make POC</button>}
              <button className="link-btn danger" aria-label={`Remove ${p.name}`} onClick={() => run(() => api.del(`/leads/${leadId}/people/${p.id}`))}>Remove</button>
            </div>
          </li>
        ))}
        {!people.length && <li className="muted">No point of contact yet.</li>}
      </ul>

      {found.length > 0 && <>
        <h4 className="sub">Found on their site</h4>
        <ul className="people-list found">
          {found.map((c) => (
            <li key={c.id}>
              <div><strong>{c.person_name}</strong>{c.role && <span className="muted"> · {c.role}</span>}<div className="person-meta">{c.value}</div></div>
              <button className="link-btn" onClick={() => add({ name: c.person_name!, role: c.role, email: c.value, source: "site", is_poc: people.length === 0 })}>Save</button>
            </li>
          ))}
        </ul>
      </>}

      {open ? (
        <form className="person-form" onSubmit={submit}>
          <input placeholder="Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required aria-label="Name" />
          <input placeholder="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} aria-label="Role" />
          <input placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} aria-label="Email" />
          <input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} aria-label="Phone" />
          <input placeholder="LinkedIn URL" value={form.linkedin} onChange={(e) => setForm({ ...form, linkedin: e.target.value })} aria-label="LinkedIn URL" />
          <div className="row"><button className="primary" type="submit">Add person</button><button type="button" onClick={() => setOpen(false)}>Cancel</button></div>
        </form>
      ) : <button className="link-btn" onClick={() => setOpen(true)}>+ Add a person</button>}
    </div>
  );
}
