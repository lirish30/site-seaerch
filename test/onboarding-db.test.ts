import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createDraft } from "../src/worker/db/documents";
import { getBusiness } from "../src/worker/db/businesses";
import { getDeal } from "../src/worker/db/deals";
import {
  addCustomItem, addFile, attachNudgeApproval, closeOnboarding, createOnboarding, forgetNudge, getAnswers, getOnboarding, getOnboardingByToken, getOnboardingForDeal,
  hasOnboarding, listFiles, listItems, listOpenOnboardings, markWelcomeSent, newToken, recordNudge, removeFile, saveAnswers, saveItemText, setItemStatus, setOwnerFields,
  setRevoked, submitQuestionnaire, touchClient, type NewItem,
} from "../src/worker/db/onboardings";
import { proposal, seedDeal } from "./fixtures/documents";

const ITEMS: NewItem[] = [
  { key: "logo", label: "Logo", instructions: "Send your logo", kind: "files", phase: 1 },
  { key: "about", label: "About text", instructions: "Tell us about you", kind: "text", phase: 1 },
  { key: "photos", label: "Photos", instructions: "Job photos", kind: "files", phase: 2 },
];
const T0 = "2026-12-03T10:00:00.000Z";
const T1 = "2026-12-03T11:00:00.000Z";

/** A lead with a deal and a draft document (the onboarding hangs off all three). */
async function seed(o: { kind?: "build" | "light"; test?: boolean; items?: NewItem[] } = {}) {
  const s = await seedDeal();
  const doc = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() });
  const r = await createOnboarding(env.DB, { businessId: s.businessId, dealId: s.dealId, documentId: doc.id, kind: o.kind ?? "build", test: o.test ?? false, items: o.items ?? ITEMS });
  return { ...s, documentId: doc.id, ...r };
}

describe("createOnboarding", () => {
  it("create is idempotent per deal and adds items once", async () => {
    const s = await seed();
    expect(s.created).toBe(true);
    expect(s.onboarding).toMatchObject({
      businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, kind: "build", test: false, revokedAt: null, welcomeVideoUrl: null, welcomeSentAt: null,
      questionnaireDueAt: null, questionnaireSubmittedAt: null, kickoffAt: null, lastClientActivityAt: null, closedAt: null,
    });
    expect(s.onboarding.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.onboarding.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const again = await createOnboarding(env.DB, {
      businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, kind: "light", test: true,
      items: [...ITEMS, { key: "extra", label: "Extra", instructions: "", kind: "text", phase: 2 }],
    });
    expect(again.created).toBe(false);
    expect(again.onboarding.id).toBe(s.onboarding.id);
    expect(again.onboarding.kind).toBe("build");
    expect(again.onboarding.token).toBe(s.onboarding.token);
    expect(await listItems(env.DB, s.onboarding.id)).toHaveLength(3);
    expect((await getOnboardingForDeal(env.DB, s.dealId))!.id).toBe(s.onboarding.id);
    expect((await getOnboarding(env.DB, s.onboarding.id))!.id).toBe(s.onboarding.id);
    expect(await getOnboarding(env.DB, "nope")).toBeNull();
    expect(await getOnboardingForDeal(env.DB, "nope")).toBeNull();
  });

  it("items come back in position order", async () => {
    const s = await seed();
    const items = await listItems(env.DB, s.onboarding.id);
    expect(items.map((i) => i.key)).toEqual(["logo", "about", "photos"]);
    expect(items.map((i) => i.position)).toEqual([0, 1, 2]);
    expect(items[0]).toMatchObject({ onboardingId: s.onboarding.id, label: "Logo", instructions: "Send your logo", kind: "files", phase: 1, dueAt: null, status: "waiting", textValue: null, custom: false });
    const extra = await addCustomItem(env.DB, s.onboarding.id, { key: "c1", label: "Menu", instructions: "PDF", kind: "files", phase: 2, dueAt: "2026-12-20T00:00:00.000Z" });
    expect(extra).toMatchObject({ key: "c1", custom: true, position: 3, dueAt: "2026-12-20T00:00:00.000Z", status: "waiting" });
    expect((await listItems(env.DB, s.onboarding.id)).map((i) => i.key)).toEqual(["logo", "about", "photos", "c1"]);
  });
});

describe("tokens", () => {
  it("getOnboardingByToken is null after revoke and works again after a new link", async () => {
    const s = await seed();
    const old = s.onboarding.token;
    expect((await getOnboardingByToken(env.DB, old))!.id).toBe(s.onboarding.id);
    const revoked = await setRevoked(env.DB, s.onboarding.id, true, T0);
    expect(revoked.revokedAt).toBe(T0);
    expect(await getOnboardingByToken(env.DB, old)).toBeNull();
    const fresh = await newToken(env.DB, s.onboarding.id);
    expect(fresh.token).not.toBe(old);
    expect(fresh.revokedAt).toBeNull();
    expect(await getOnboardingByToken(env.DB, old)).toBeNull();
    expect((await getOnboardingByToken(env.DB, fresh.token))!.id).toBe(s.onboarding.id);
    // Revoking can be undone without a new link.
    await setRevoked(env.DB, s.onboarding.id, true, T0);
    expect((await setRevoked(env.DB, s.onboarding.id, false, T1)).revokedAt).toBeNull();
    expect((await getOnboardingByToken(env.DB, fresh.token))!.id).toBe(s.onboarding.id);
  });
});

describe("questionnaire", () => {
  it("saveAnswers upserts and bumps lastClientActivityAt", async () => {
    const s = await seed();
    await saveAnswers(env.DB, s.onboarding.id, { q1: "one", q2: "two" }, T0);
    expect(await getAnswers(env.DB, s.onboarding.id)).toEqual({ q1: "one", q2: "two" });
    expect((await getOnboarding(env.DB, s.onboarding.id))!.lastClientActivityAt).toBe(T0);
    await saveAnswers(env.DB, s.onboarding.id, { q2: "TWO", q3: "three" }, T1);
    expect(await getAnswers(env.DB, s.onboarding.id)).toEqual({ q1: "one", q2: "TWO", q3: "three" });
    expect((await getOnboarding(env.DB, s.onboarding.id))!.lastClientActivityAt).toBe(T1);
    expect(await getAnswers(env.DB, "nope")).toEqual({});
  });

  it("submitQuestionnaire is submitted once then already", async () => {
    const s = await seed();
    expect(await submitQuestionnaire(env.DB, s.onboarding.id, T0)).toBe("submitted");
    expect(await submitQuestionnaire(env.DB, s.onboarding.id, T1)).toBe("already");
    const o = (await getOnboarding(env.DB, s.onboarding.id))!;
    expect(o.questionnaireSubmittedAt).toBe(T0);
    expect(o.lastClientActivityAt).toBe(T0);
  });
});

describe("welcome", () => {
  it("markWelcomeSent is true once and sets due dates by phase", async () => {
    const s = await seed();
    const o = { sentAt: T0, questionnaireDueAt: "2026-12-10T00:00:00.000Z", phaseDue: { 1: "2026-12-12T00:00:00.000Z", 2: "2026-12-20T00:00:00.000Z" } as { 1: string; 2: string } };
    expect(await markWelcomeSent(env.DB, s.onboarding.id, o)).toBe(true);
    expect(await markWelcomeSent(env.DB, s.onboarding.id, { ...o, sentAt: T1, phaseDue: { 1: "2027-01-01T00:00:00.000Z", 2: "2027-01-02T00:00:00.000Z" } })).toBe(false);
    const row = (await getOnboarding(env.DB, s.onboarding.id))!;
    expect(row).toMatchObject({ welcomeSentAt: T0, questionnaireDueAt: "2026-12-10T00:00:00.000Z", lastClientActivityAt: T0 });
    const items = await listItems(env.DB, s.onboarding.id);
    expect(items.map((i) => [i.key, i.dueAt])).toEqual([
      ["logo", "2026-12-12T00:00:00.000Z"], ["about", "2026-12-12T00:00:00.000Z"], ["photos", "2026-12-20T00:00:00.000Z"],
    ]);
  });
});

describe("items", () => {
  it("a file makes its item received and removing the last file makes it waiting", async () => {
    const s = await seed();
    const [logo] = await listItems(env.DB, s.onboarding.id);
    await addFile(env.DB, { id: "f1", itemId: logo.id, r2Key: "onboarding/a/f1", fileName: "logo.png", contentType: "image/png", sizeBytes: 100, now: T0 });
    await addFile(env.DB, { id: "f2", itemId: logo.id, r2Key: "onboarding/a/f2", fileName: "logo2.png", contentType: "image/png", sizeBytes: 200, now: T1 });
    expect((await listItems(env.DB, s.onboarding.id))[0].status).toBe("received");
    expect(await listFiles(env.DB, logo.id)).toEqual([
      { id: "f1", itemId: logo.id, r2Key: "onboarding/a/f1", fileName: "logo.png", contentType: "image/png", sizeBytes: 100, uploadedAt: T0 },
      { id: "f2", itemId: logo.id, r2Key: "onboarding/a/f2", fileName: "logo2.png", contentType: "image/png", sizeBytes: 200, uploadedAt: T1 },
    ]);
    expect((await removeFile(env.DB, "f1"))!.r2Key).toBe("onboarding/a/f1");
    expect((await listItems(env.DB, s.onboarding.id))[0].status).toBe("received");
    expect((await removeFile(env.DB, "f2"))!.fileName).toBe("logo2.png");
    expect((await listItems(env.DB, s.onboarding.id))[0].status).toBe("waiting");
    expect(await listFiles(env.DB, logo.id)).toEqual([]);
    expect(await removeFile(env.DB, "f2")).toBeNull();
  });

  it("text on an accepted item keeps accepted", async () => {
    const s = await seed();
    const about = (await listItems(env.DB, s.onboarding.id))[1];
    await saveItemText(env.DB, about.id, "We fix pipes", T0);
    expect((await listItems(env.DB, s.onboarding.id))[1]).toMatchObject({ status: "received", textValue: "We fix pipes", updatedAt: T0 });
    await saveItemText(env.DB, about.id, "", T1);
    expect((await listItems(env.DB, s.onboarding.id))[1].status).toBe("waiting");
    await setItemStatus(env.DB, about.id, "accepted");
    await saveItemText(env.DB, about.id, "We fix pipes fast", T1);
    expect((await listItems(env.DB, s.onboarding.id))[1]).toMatchObject({ status: "accepted", textValue: "We fix pipes fast" });
    await saveItemText(env.DB, about.id, "", T1);
    expect((await listItems(env.DB, s.onboarding.id))[1].status).toBe("accepted");
    await setItemStatus(env.DB, about.id, "not_applicable");
    await saveItemText(env.DB, about.id, "x", T1);
    expect((await listItems(env.DB, s.onboarding.id))[1].status).toBe("not_applicable");
  });
});

describe("owner fields and lifecycle", () => {
  it("setOwnerFields, touchClient, closeOnboarding and listOpenOnboardings", async () => {
    const a = await seed();
    const b = await seed();
    const set = await setOwnerFields(env.DB, a.onboarding.id, { welcomeVideoUrl: "https://v.test/1", kickoffAt: "2026-12-15T17:00:00.000Z" });
    expect(set).toMatchObject({ welcomeVideoUrl: "https://v.test/1", kickoffAt: "2026-12-15T17:00:00.000Z" });
    // A field left out is not touched; null clears.
    expect(await setOwnerFields(env.DB, a.onboarding.id, { kickoffAt: null })).toMatchObject({ welcomeVideoUrl: "https://v.test/1", kickoffAt: null });
    await touchClient(env.DB, a.onboarding.id, T1);
    expect((await getOnboarding(env.DB, a.onboarding.id))!.lastClientActivityAt).toBe(T1);
    let open = (await listOpenOnboardings(env.DB)).map((o) => o.id);
    expect(open).toContain(a.onboarding.id);
    expect(open).toContain(b.onboarding.id);
    await closeOnboarding(env.DB, a.onboarding.id, T1);
    expect((await getOnboarding(env.DB, a.onboarding.id))!.closedAt).toBe(T1);
    await closeOnboarding(env.DB, a.onboarding.id, "2027-01-01T00:00:00.000Z");
    expect((await getOnboarding(env.DB, a.onboarding.id))!.closedAt).toBe(T1);
    // A revoked link alone does not take it off the list.
    await setRevoked(env.DB, b.onboarding.id, true, T1);
    open = (await listOpenOnboardings(env.DB)).map((o) => o.id);
    expect(open).not.toContain(a.onboarding.id);
    expect(open).toContain(b.onboarding.id);
  });
});

describe("nudges", () => {
  it("recordNudge is true once per key", async () => {
    const s = await seed();
    expect(await recordNudge(env.DB, s.onboarding.id, "questionnaire-3d", T0)).toBe(true);
    expect(await recordNudge(env.DB, s.onboarding.id, "questionnaire-3d", T1)).toBe(false);
    expect(await recordNudge(env.DB, s.onboarding.id, "items-7d", T1)).toBe(true);
    await attachNudgeApproval(env.DB, s.onboarding.id, "questionnaire-3d", "appr-1");
    expect(await env.DB.prepare(`SELECT approval_id, created_at FROM onboarding_nudges WHERE onboarding_id = ? AND key = ?`).bind(s.onboarding.id, "questionnaire-3d").first())
      .toEqual({ approval_id: "appr-1", created_at: T0 });
    await forgetNudge(env.DB, s.onboarding.id, "questionnaire-3d");
    expect(await recordNudge(env.DB, s.onboarding.id, "questionnaire-3d", T1)).toBe(true);
  });
});

describe("hasOnboarding and the lead delete route", () => {
  let cookie = "";
  beforeAll(async () => {
    const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  });
  const del = (id: string) => SELF.fetch(`https://x/api/leads/${id}`, { method: "DELETE", headers: { cookie } });

  it("hasOnboarding is true once one exists", async () => {
    const s = await seedDeal();
    expect(await hasOnboarding(env.DB, s.businessId)).toBe(false);
    const doc = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() });
    await createOnboarding(env.DB, { businessId: s.businessId, dealId: s.dealId, documentId: doc.id, kind: "light", test: false, items: [] });
    expect(await hasOnboarding(env.DB, s.businessId)).toBe(true);
  });

  it("the lead delete route refuses a lead that has an onboarding", async () => {
    const s = await seed({ items: [] });
    // The document is only a draft, so it is the onboarding that keeps the lead.
    const res = await del(s.businessId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "this lead has an onboarding" });
    expect(await getBusiness(env.DB, s.businessId)).not.toBeNull();
    expect(await getDeal(env.DB, s.dealId)).not.toBeNull();
    expect(await getOnboarding(env.DB, s.onboarding.id)).not.toBeNull();
  });
});
