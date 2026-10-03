import { describe, it, expect } from "vitest";
import { pickRecipient } from "../src/worker/recipient";
import type { Contact } from "../src/worker/types";

let n = 0;
const c = (o: Partial<Contact>): Contact => ({
  id: `c${n++}`, business_id: "b", type: "email", value: "", source_url: null,
  person_name: null, role: null, confidence: 0.8, ...o,
});

describe("pickRecipient", () => {
  it("prefers named owner on own domain over generic inbox", () => {
    const r = pickRecipient([c({ value: "info@ace.com" }), c({ value: "jane@ace.com", person_name: "Jane", role: "Owner" })], "ace.com");
    expect(r.emailContact!.value).toBe("jane@ace.com");
    expect(r.reason).toMatch(/Jane/);
  });

  it("orders generic inboxes owner > info > contact > office > other", () => {
    const r = pickRecipient([c({ value: "office@ace.com" }), c({ value: "sales@ace.com" }), c({ value: "info@ace.com" })], "ace.com");
    expect(r.ranked.map((x) => x.value)).toEqual(["info@ace.com", "office@ace.com", "sales@ace.com"]);
  });

  it("own-domain beats gmail", () => {
    const r = pickRecipient([c({ value: "acebob@gmail.com" }), c({ value: "hello@ace.com" })], "ace.com");
    expect(r.emailContact!.value).toBe("hello@ace.com");
  });

  it("falls back to form then phone with explanatory reason", () => {
    const form = pickRecipient([c({ type: "phone", value: "555" }), c({ type: "form", value: "https://ace.com/contact" })], "ace.com");
    expect(form.emailContact).toBeNull();
    expect(form.contact!.type).toBe("form");
    expect(form.reason).toBe("No email found. Use the contact form at https://ace.com/contact");
    const phone = pickRecipient([c({ type: "phone", value: "555-1234" })], "ace.com");
    expect(phone.reason).toBe("No email or form found. Call 555-1234");
  });

  it("handles no contacts", () => {
    const r = pickRecipient([], null);
    expect(r.contact).toBeNull();
    expect(r.reason).toBe("No contact details found");
  });
});
