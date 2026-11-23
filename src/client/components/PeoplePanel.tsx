import { useState } from "react";
import { api } from "../api";
import type { Contact, Person } from "../types";
import { initials } from "../scoreView";
import Icon from "./Icon";

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

  const field = (key: keyof typeof blank, label: string, o: { type?: string; placeholder?: string; wide?: boolean; required?: boolean } = {}) => (
    <label className={`clx-lead-field${o.wide ? " wide" : ""}`}>
      <span>{label}{o.required && <i aria-hidden="true"> *</i>}</span>
      <input type={o.type ?? "text"} value={form[key]} placeholder={o.placeholder} required={o.required} autoComplete="off" aria-label={label}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
    </label>
  );

  return (
    <div className="people clx-lead-people">
      {people.length > 0 ? (
        <ul className="clx-lead-plist" aria-label="Saved people">
          {people.map((p) => (
            <li key={p.id}>
              <span className="avatar-sm" aria-hidden="true">{initials(p.name)}</span>
              <span className="clx-lead-ptext">
                <span className="clx-lead-pname"><b>{p.name}</b>{p.is_poc && <span className="clx-lead-chip signal">POC</span>}</span>
                {p.role && <small>{p.role}</small>}
                {(p.email || p.phone || (p.linkedin && /^https?:\/\//.test(p.linkedin))) && (
                  <span className="clx-lead-pmeta">
                    {p.email && <a href={`mailto:${p.email}`}>{p.email}</a>}
                    {p.phone && <a href={`tel:${p.phone}`}>{p.phone}</a>}
                    {p.linkedin && /^https?:\/\//.test(p.linkedin) && <a href={p.linkedin} target="_blank" rel="noreferrer">LinkedIn</a>}
                  </span>
                )}
                <span className="clx-lead-pacts">
                  {!p.is_poc && <button type="button" className="link-btn" onClick={() => run(() => api.patch(`/leads/${leadId}/people/${p.id}`, { is_poc: true }))}>Make point of contact</button>}
                  <button type="button" className="link-btn danger" aria-label={`Remove ${p.name}`} onClick={() => run(() => api.del(`/leads/${leadId}/people/${p.id}`))}>Remove</button>
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="clx-lead-pnone">No one saved yet. The first person you save becomes the point of contact, and drafts are addressed to them.</p>}

      {found.length > 0 && <>
        <p className="clx-lead-over">Found on their site</p>
        <ul className="clx-lead-plist found" aria-label="Found on their site">
          {found.map((c) => (
            <li key={c.id}>
              <span className="clx-lead-found-ico" aria-hidden="true"><Icon name="sparkles" size={13} /></span>
              <span className="clx-lead-ptext"><b>{c.person_name}</b><small>{[c.role, c.value].filter(Boolean).join(" · ")}</small></span>
              <button type="button" className="btn sm" onClick={() => add({ name: c.person_name!, role: c.role, email: c.value, source: "site", is_poc: people.length === 0 })}>Save</button>
            </li>
          ))}
        </ul>
      </>}

      {open ? (
        <form className="clx-lead-form" onSubmit={submit} aria-label="Add a person">
          <p className="clx-lead-over wide">Add a person</p>
          {field("name", "Name", { required: true })}
          {field("role", "Role", { placeholder: "Owner, office manager" })}
          {field("email", "Email", { type: "email", wide: true })}
          {field("phone", "Phone", { type: "tel" })}
          {field("linkedin", "LinkedIn", { placeholder: "https://…" })}
          <div className="clx-lead-form-actions">
            <button className="btn primary sm" type="submit" disabled={!form.name.trim()}>Add person</button>
            <button className="btn sm" type="button" onClick={() => { setOpen(false); setForm(blank); }}>Cancel</button>
          </div>
        </form>
      ) : <button type="button" className="btn sm clx-lead-padd" onClick={() => setOpen(true)}><Icon name="plus" size={14} />Add a person</button>}
    </div>
  );
}
