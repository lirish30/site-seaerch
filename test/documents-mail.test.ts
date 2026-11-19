import { describe, expect, it } from "vitest";
import type { Settings } from "../src/worker/types";
import { clientLink, renderProposalMail } from "../src/worker/documents/mail";
import { composeOutbound } from "../src/worker/mail/send";
import { proposal } from "./fixtures/documents";

const settings = { your_name: "Logan Irish", signature: "", signature_json: "", physical_address: "", opt_out_line: "" } as Settings;
const TOKEN = "t".repeat(43), BASE = "https://clients.hellositeline.test";
const frozen = (o: { contactName?: string; clientName?: string } = {}) => {
  const p = proposal();
  return {
    ...p,
    header: { ...p.header, contactName: o.contactName ?? "Pat Jones", clientName: o.clientName ?? "Ace Plumbing", providerBusiness: "Siteline", sentOn: "2026-12-01T17:00:00.000Z", expiresOn: "2026-12-31T17:00:00.000Z" },
    packages: [{ key: "starter_site" as const, version: 1, name: "Starter Site", priceLine: "from $3,997", includes: [] }],
    schedule: { ...p.schedule, depositCents: 199850 },
  };
};

describe("renderProposalMail", () => {
  it("the mail contains the link, the expiry date and the deposit amount and nothing else priced", () => {
    const link = clientLink(BASE, TOKEN)!;
    const m = renderProposalMail(frozen(), link, settings);
    expect(m.subject).toBe("Your proposal from Siteline");
    expect(m.body.startsWith("Hi Pat,")).toBe(true);
    expect(m.body).toContain("Ace Plumbing");
    expect(m.body).toContain(link);
    expect(m.body).toContain("December 31, 2026");
    expect(m.body).toContain("open it, read it, type your name to sign");
    expect(m.body).toContain("$1,998.50");
    expect(m.body).toMatch(/payment step follows signing/);
    // The deposit is the only dollar figure: the package price in the proposal is not repeated.
    expect(m.body.match(/\$[\d,]+(\.\d+)?/g)).toEqual(["$1,998.50"]);
    expect(m.body).not.toContain("3,997");
    expect(m.body).not.toContain("workers.dev");
    expect(m.body.trimEnd().endsWith("Logan Irish")).toBe(true);
  });

  it("a configured signature is the sender's to add, so the name is not repeated", () => {
    const m = renderProposalMail(frozen(), clientLink(BASE, TOKEN)!, { ...settings, signature: "Logan\nSiteline" });
    expect(m.body.trimEnd().endsWith("Thanks,")).toBe(true);
    expect(composeOutbound({ ...settings, signature: "Logan\nSiteline" }, { mailbox: "main", subject: m.subject, body: m.body, includeFooter: false }).text).toContain("Thanks,\n\nLogan\nSiteline");
  });

  it("a contact name with markup stays plain text in the body", () => {
    const name = `<script>alert(1)</script> Pat`;
    const m = renderProposalMail(frozen({ contactName: name, clientName: `<b>Ace</b>` }), clientLink(BASE, TOKEN)!, settings);
    expect(m.body).toContain("<script>alert(1)</script>");
    const html = composeOutbound(settings, { mailbox: "main", subject: m.subject, body: m.body, includeFooter: false }).html;
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>Ace");
    expect(html).toContain("&lt;script&gt;");
    expect(m.subject).not.toMatch(/[<>\r\n]/);
  });

  it("a name with line breaks stays on one line and no name still greets", () => {
    expect(renderProposalMail(frozen({ contactName: "Pat\r\nBcc: x@y.test" }), "https://x.test/p/t", settings).body.split("\n")[0]).toBe("Hi Pat,");
    expect(renderProposalMail(frozen({ contactName: "  " }), "https://x.test/p/t", settings).body.split("\n")[0]).toBe("Hi,");
  });
});

describe("clientLink", () => {
  it("clientLink is null for a non-https base", () => {
    expect(clientLink("http://clients.example.com", TOKEN)).toBeNull();
    expect(clientLink("", TOKEN)).toBeNull();
    expect(clientLink(undefined, TOKEN)).toBeNull();
    expect(clientLink("ftp://x.test", TOKEN)).toBeNull();
    expect(clientLink("https://app.workers.dev", TOKEN)).toBeNull();
  });
  it("builds /p/<token> on the base, ignoring a trailing slash", () => {
    expect(clientLink(`${BASE}/`, TOKEN)).toBe(`${BASE}/p/${TOKEN}`);
  });
});
