import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createDraft, getDocument, listForDeal, signDocument } from "../src/worker/db/documents";
import { getBusiness } from "../src/worker/db/businesses";
import { getDeal } from "../src/worker/db/deals";
import { clientSig, proposal, seedDeal, sendDraft } from "./fixtures/documents";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
const del = (id: string) => SELF.fetch(`https://x/api/leads/${id}`, { method: "DELETE", headers: { cookie } });

describe("deleting a lead that has documents", () => {
  it("a lead with a signed document cannot be deleted", async () => {
    const s = await seedDeal();
    const doc = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() });
    const sent = await sendDraft(doc.id, doc.content);
    expect(await signDocument(env.DB, doc.id, clientSig(sent.hash), "2026-12-02T09:00:00.000Z")).toBe("signed");
    const res = await del(s.businessId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "this lead has signed documents" });
    expect(await getBusiness(env.DB, s.businessId)).not.toBeNull();
    expect(await getDeal(env.DB, s.dealId)).not.toBeNull();
    expect((await getDocument(env.DB, doc.id))!.status).toBe("signed");
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM document_signatures WHERE document_id = ?`).bind(doc.id).first<{ n: number }>()).toEqual({ n: 2 });
  });

  it("a sent document and a void one also keep the lead", async () => {
    const sentLead = await seedDeal();
    const d = await createDraft(env.DB, { dealId: sentLead.dealId, businessId: sentLead.businessId, optionId: "b", content: proposal() });
    await sendDraft(d.id, d.content);
    expect((await del(sentLead.businessId)).status).toBe(409);
    expect(await getBusiness(env.DB, sentLead.businessId)).not.toBeNull();
  });

  it("a lead with only drafts is deleted with them", async () => {
    const s = await seedDeal();
    const doc = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() });
    await env.DB.prepare(`INSERT INTO document_views (id, document_id, viewed_at, user_agent) VALUES ('v1', ?, '2026-12-02T09:00:00.000Z', NULL)`).bind(doc.id).run();
    const res = await del(s.businessId);
    expect(res.status).toBe(200);
    expect(await getBusiness(env.DB, s.businessId)).toBeNull();
    expect(await getDeal(env.DB, s.dealId)).toBeNull();
    expect(await getDocument(env.DB, doc.id)).toBeNull();
    expect(await listForDeal(env.DB, s.dealId)).toEqual([]);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM document_views WHERE document_id = ?`).bind(doc.id).first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("a lead with no documents is deleted as before", async () => {
    const s = await seedDeal();
    expect((await del(s.businessId)).status).toBe(200);
    expect(await getBusiness(env.DB, s.businessId)).toBeNull();
  });
});
