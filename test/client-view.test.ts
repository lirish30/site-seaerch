import { describe, expect, it } from "vitest";
import {
  accessActions, accessTone, clientLinkFor, addressProblem, friendlyProblem, latestOnly, problemText, projectStatusLabel, accessWords, carePastDue, moneyLabel, renewalLabel, safeHref, serverProblem, siteTitle, sortClients, vaultHint,
} from "../src/client/clientView";
import { ACCESS_STATUSES } from "../src/worker/db/sites";
import type { ClientRow } from "../src/worker/clients/record";

describe("accessTone", () => {
  it("marks needed and requested as warn, received and verified as good", () => {
    expect(accessTone("needed")).toBe("warn");
    expect(accessTone("requested")).toBe("warn");
    expect(accessTone("received")).toBe("good");
    expect(accessTone("verified")).toBe("good");
  });
  it("leaves not applicable neutral", () => {
    expect(accessTone("not_applicable")).toBe("neutral");
  });
});

describe("accessActions", () => {
  it("never offers the current status", () => {
    for (const s of ACCESS_STATUSES) expect(accessActions(s), s).not.toContain(s);
  });
  it("offers the next sensible moves", () => {
    // A client sometimes sends access unprompted, so a needed line can go straight to received.
    expect(accessActions("needed")).toEqual(["requested", "received", "not_applicable"]);
    expect(accessActions("requested")).toEqual(["received", "needed", "not_applicable"]);
    expect(accessActions("received")).toEqual(["verified", "requested", "not_applicable"]);
    expect(accessActions("verified")).toEqual(["received", "not_applicable"]);
    expect(accessActions("not_applicable")).toEqual(["needed"]);
  });
  it("only ever offers real statuses, each at most once", () => {
    for (const s of ACCESS_STATUSES) {
      const a = accessActions(s);
      expect(new Set(a).size).toBe(a.length);
      for (const x of a) expect(ACCESS_STATUSES).toContain(x);
    }
  });
  it("has a plain word for every status", () => {
    for (const s of ACCESS_STATUSES) expect(accessWords(s).length).toBeGreaterThan(0);
    expect(accessWords("not_applicable")).toBe("Not applicable");
  });
});

describe("moneyLabel", () => {
  it("formats integer cents and never shows NaN for 0", () => {
    expect(moneyLabel(12900)).toBe("$129");
    expect(moneyLabel(199850)).toBe("$1,998.50");
    expect(moneyLabel(5)).toBe("$0.05");
    expect(moneyLabel(0)).toBe("$0");
    expect(moneyLabel(Number.NaN)).toBe("$0");
    expect(moneyLabel(Number.POSITIVE_INFINITY)).toBe("$0");
  });
  it("adds /mo when it is a monthly amount", () => {
    expect(moneyLabel(12900, { monthly: true })).toBe("$129/mo");
    expect(moneyLabel(0, { monthly: true })).toBe("$0/mo");
  });
  it("groups thousands and keeps the sign", () => {
    expect(moneyLabel(123456789)).toBe("$1,234,567.89");
    expect(moneyLabel(-2500)).toBe("-$25");
  });
});

describe("renewalLabel", () => {
  const TODAY = "2026-11-20";
  it("handles today, past, null and a date 400 days out", () => {
    expect(renewalLabel("2026-11-20", TODAY)).toBe("Renews today");
    expect(renewalLabel("2026-11-21", TODAY)).toBe("Renews tomorrow");
    expect(renewalLabel("2026-12-02", TODAY)).toBe("Renews in 12 days");
    expect(renewalLabel("2026-11-19", TODAY)).toBe("Term ended");
    expect(renewalLabel("2025-01-01", TODAY)).toBe("Term ended");
    expect(renewalLabel(null, TODAY)).toBe("No term");
    // 400 days after 2026-11-20 is 2027-12-25: far enough out that a date reads better than a count.
    expect(renewalLabel("2027-12-25", TODAY)).toBe("Renews 25 Dec 2027");
  });
  it("counts across a month and a year end", () => {
    expect(renewalLabel("2027-01-05", TODAY)).toBe("Renews in 46 days");
  });
  it("reads an unreadable date as no term rather than NaN", () => {
    expect(renewalLabel("soon", TODAY)).toBe("No term");
    expect(renewalLabel("2026-13-40", TODAY)).toBe("No term");
  });
});

describe("siteTitle", () => {
  it("is the domain when there is one", () => {
    expect(siteTitle({ domain: "example.com" })).toBe("example.com");
  });
  it("for a site with no domain", () => {
    expect(siteTitle({ domain: null })).toBe("New site (no domain yet)");
    expect(siteTitle({ domain: "  " })).toBe("New site (no domain yet)");
  });
});

describe("safeHref", () => {
  it("rejects javascript:, data: and an empty string", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("  JavaScript:alert(1)")).toBeNull();
    expect(safeHref("java\tscript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeHref("")).toBeNull();
    expect(safeHref("   ")).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
  it("rejects other schemes and things that are not addresses", () => {
    expect(safeHref("ftp://example.com/file")).toBeNull();
    expect(safeHref("mailto:a@example.com")).toBeNull();
    expect(safeHref("//example.com")).toBeNull();
    expect(safeHref("example.com")).toBeNull();
    expect(safeHref("/clients/1")).toBeNull();
  });
  it("keeps http and https and nothing that carries a login", () => {
    expect(safeHref("https://example.com/wp-admin")).toBe("https://example.com/wp-admin");
    expect(safeHref(" http://example.com ")).toBe("http://example.com/");
    expect(safeHref("https://admin:pw@example.com/")).toBeNull();
  });
});

describe("carePastDue", () => {
  const sub = (o: Partial<{ packageKey: string; status: string; test: boolean }>) => ({ packageKey: "care", status: "active", test: false, ...o });
  it("is true only for a real Care subscription that is past due", () => {
    expect(carePastDue([sub({ status: "past_due" })])).toBe(true);
    expect(carePastDue([sub({ packageKey: "care_plus", status: "past_due" })])).toBe(true);
    expect(carePastDue([sub({ packageKey: "care_fallback", status: "past_due" })])).toBe(true);
  });
  it("is false for active Care, a past-due build, a test row or nothing", () => {
    expect(carePastDue([sub({})])).toBe(false);
    expect(carePastDue([sub({ packageKey: "build", status: "past_due" })])).toBe(false);
    expect(carePastDue([sub({ status: "past_due", test: true })])).toBe(false);
    expect(carePastDue([])).toBe(false);
  });
});

describe("sortClients", () => {
  const row = (name: string, mrrCents: number, accessMissing: number): ClientRow => ({
    id: name, name, test: false, careLabel: null, mrrCents, siteCount: 1, accessMissing, openInvoiceCents: 0, held: false, nextRenewalOn: null, healthScore: null,
  });
  const rows = [row("Beta", 5000, 0), row("alpha", 12900, 3), row("Cedar", 12900, 6), row("Delta", 0, 3)];
  const names = (r: ClientRow[]) => r.map((x) => x.name);
  it("by name ignores case", () => expect(names(sortClients(rows, "name"))).toEqual(["alpha", "Beta", "Cedar", "Delta"]));
  it("by MRR puts the biggest first and breaks ties by name", () => expect(names(sortClients(rows, "mrr"))).toEqual(["alpha", "Cedar", "Beta", "Delta"]));
  it("by access missing puts the most missing first and breaks ties by name", () => expect(names(sortClients(rows, "access"))).toEqual(["Cedar", "alpha", "Delta", "Beta"]));
  it("does not change the list it was given", () => {
    const before = names(rows);
    sortClients(rows, "mrr");
    expect(names(rows)).toEqual(before);
  });
});

describe("vaultHint", () => {
  it("says what to type and what never to", () => {
    expect(vaultHint(null)).toBe("Type the name of the password manager item. Never the login.");
  });
  it("shows the server's refusal as it is for an ordinary refusal", () => {
    expect(vaultHint("That looks like a login or a key. Type only the name of the password manager item.")).toBe(
      "That looks like a login or a key. Type only the name of the password manager item.",
    );
  });
  it("asks for spaces between words when the name was a single slug", () => {
    const hint = vaultHint("That looks like a login or a key. Type only the name of the password manager item.", "acme-hosting-wpengine-2024");
    expect(hint).toContain("Use spaces between words.");
  });
  it("does not add the spaces hint for a plain name that was refused for another reason", () => {
    expect(vaultHint("A password manager item name is 80 characters or fewer.", "Acme hosting login")).not.toContain("Use spaces between words.");
  });
});

describe("serverProblem", () => {
  it("reads the server's plain sentence for a field out of a 400", () => {
    const body = { error: "invalid body", fields: { vaultItem: ["That looks like a login or a key. Type only the name of the password manager item."] } };
    expect(serverProblem(body, "Could not save.")).toBe("That looks like a login or a key. Type only the name of the password manager item.");
  });
  it("joins several fields, or only the ones asked for", () => {
    const body = { error: "invalid body", fields: { url: ["The site address must start with http:// or https://."], notes: ["A note is 500 characters or fewer."] } };
    expect(serverProblem(body, "x")).toBe("The site address must start with http:// or https://. A note is 500 characters or fewer.");
    expect(serverProblem(body, "x", ["notes"])).toBe("A note is 500 characters or fewer.");
  });
  it("uses the error sentence of a 409 and the fallback for anything it cannot read", () => {
    expect(serverProblem({ error: "this client already has a live site with that domain" }, "Could not save.")).toBe("this client already has a live site with that domain");
    expect(serverProblem({ error: "invalid body", fields: {} }, "Could not save.")).toBe("Could not save.");
    expect(serverProblem(undefined, "Could not save.")).toBe("Could not save.");
    expect(serverProblem("nope", "Could not save.")).toBe("Could not save.");
  });
});

describe("latestOnly", () => {
  it("applies the latest result and ignores a stale one that arrives late", () => {
    const guard = latestOnly();
    const first = guard.next();
    const second = guard.next();
    expect(guard.isLatest(first)).toBe(false);
    expect(guard.isLatest(second)).toBe(true);
  });
  it("lets a request through when nothing newer has started", () => {
    const guard = latestOnly();
    expect(guard.isLatest(guard.next())).toBe(true);
  });
  it("drops everything in flight once cancelled (the page changed or went away)", () => {
    const guard = latestOnly();
    const t = guard.next();
    guard.cancel();
    expect(guard.isLatest(t)).toBe(false);
    expect(guard.isLatest(guard.next())).toBe(true);
  });
  it("a late response for client A never lands once client B has been asked for", async () => {
    const guard = latestOnly();
    let shown = "";
    const load = async (id: string, delayMs: number) => {
      const t = guard.next();
      await new Promise((r) => setTimeout(r, delayMs));
      if (guard.isLatest(t)) shown = id;
    };
    await Promise.all([load("A", 20), load("B", 1)]);
    expect(shown).toBe("B");
  });
});

describe("friendlyProblem", () => {
  it("never shows the raw words of a failed call", () => {
    expect(friendlyProblem("invalid body", "Could not save.")).toBe("Could not save.");
    expect(friendlyProblem("HTTP 500", "Could not save.")).toBe("Could not save.");
    expect(friendlyProblem("HTTP 400", "Could not save.")).toBe("Could not save.");
    expect(friendlyProblem("", "Could not save.")).toBe("Could not save.");
    expect(friendlyProblem(undefined, "Could not save.")).toBe("Could not save.");
  });
  it("keeps a plain sentence from the server", () => {
    expect(friendlyProblem("this client already has a live site with that domain", "x")).toBe("this client already has a live site with that domain");
  });
});

describe("addressProblem", () => {
  it("is null for an empty address and for a plain http or https one", () => {
    expect(addressProblem("")).toBeNull();
    expect(addressProblem("  ")).toBeNull();
    expect(addressProblem("https://example.com")).toBeNull();
  });
  it("tells a login in the address apart from a missing scheme", () => {
    expect(addressProblem("https://user:pw@example.com/")).toBe("Leave the login out of the address.");
    expect(addressProblem("http://user@example.com")).toBe("Leave the login out of the address.");
    expect(addressProblem("example.com")).toBe("The site address must start with http:// or https://.");
    expect(addressProblem("javascript:alert(1)")).toBe("The site address must start with http:// or https://.");
  });
  it("never repeats what was typed", () => {
    expect(addressProblem("https://admin:hunter2@example.com")).not.toContain("hunter2");
  });
  it("names the field it is about", () => {
    expect(addressProblem("nope", "The admin address")).toBe("The admin address must start with http:// or https://.");
  });
});

describe("problemText", () => {
  const err = (message: string, body?: unknown) => Object.assign(new Error(message), { body });
  it("reads the server's field sentence out of a failed call", () => {
    const e = err("invalid body", { error: "invalid body", fields: { notes: ["A note is 500 characters or fewer."] } });
    expect(problemText(e, "Could not save.")).toBe("A note is 500 characters or fewer.");
  });
  it("uses a fixed sentence when a 400 has no usable field messages, never the raw words", () => {
    expect(problemText(err("invalid body", { error: "invalid body", fields: {} }), "Could not save.")).toBe("Could not save.");
    expect(problemText(err("HTTP 500", {}), "Could not save.")).toBe("Could not save.");
    expect(problemText(err("HTTP 500"), "Could not save.")).toBe("Could not save.");
  });
  it("keeps the sentence of a 409", () => {
    expect(problemText(err("x", { error: "this client already has a live site with that domain" }), "Could not save.")).toBe("this client already has a live site with that domain");
  });
});

describe("projectStatusLabel", () => {
  it("labels a project from its status alone, with no waiting-on-client guess", () => {
    expect(projectStatusLabel({ status: "active", kind: "build" })).toEqual({ label: "Active", tone: "neutral" });
    expect(projectStatusLabel({ status: "paused", kind: "build" })).toEqual({ label: "Paused", tone: "warn" });
    expect(projectStatusLabel({ status: "done", kind: "build" })).toEqual({ label: "Done", tone: "good" });
    expect(projectStatusLabel({ status: "cancelled", kind: "build" })).toEqual({ label: "Cancelled", tone: "muted" });
  });
  it("a finished Care setup is the client's running Care service", () => {
    expect(projectStatusLabel({ status: "done", kind: "care_onboarding" })).toEqual({ label: "Care running", tone: "good" });
  });
});

describe("clientLinkFor", () => {
  it("links a won lead to its client record", () => {
    expect(clientLinkFor({ id: "abc123", lead_status: "won" })).toBe("/clients/abc123");
  });
  it("encodes an id with a slash or a space so it stays one path segment", () => {
    expect(clientLinkFor({ id: "a/b", lead_status: "won" })).toBe("/clients/a%2Fb");
    expect(clientLinkFor({ id: "Acme Co", lead_status: "won" })).toBe("/clients/Acme%20Co");
  });
  it("has no link for a lead that is not won", () => {
    expect(clientLinkFor({ id: "abc123", lead_status: "new" })).toBeNull();
    expect(clientLinkFor({ id: "abc123", lead_status: "contacted" })).toBeNull();
    expect(clientLinkFor({ id: "abc123", lead_status: "lost" })).toBeNull();
  });
});
