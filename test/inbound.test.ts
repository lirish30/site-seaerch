import { describe, expect, it } from "vitest";
import { classifyInbound, parseInbound, stripQuoted } from "../src/worker/mail/inbound";
import replyEml from "./fixtures/mail/reply.eml?raw";
import footerEml from "./fixtures/mail/reply-quoted-footer.eml?raw";
import stopEml from "./fixtures/mail/stop.eml?raw";
import bounceEml from "./fixtures/mail/bounce-dsn.eml?raw";
import oooEml from "./fixtures/mail/ooo.eml?raw";
import hugeEml from "./fixtures/mail/huge.eml?raw";

const bytes = (s: string) => new TextEncoder().encode(s);
const kindOf = async (eml: string) => classifyInbound(await parseInbound(bytes(eml)));
const withBody = (body: string) =>
  `From: Pat <pat@example.test>\r\nTo: outreach@hellositeline.test\r\nSubject: Re: hello\r\nMessage-ID: <m1@example.test>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}\r\n`;

describe("parseInbound", () => {
  it("reads headers and body of a plain reply", async () => {
    const m = await parseInbound(bytes(replyEml));
    expect(m.messageId).toBe("<CAK7r2b1e3F9@mail.brightsmiles.example>");
    expect(m.inReplyTo).toBe("<6b1d2c7e-4a51-4c1e-9d0a-3f0c8d5e7a11@hellositeline.test>");
    expect(m.references).toEqual(["<6b1d2c7e-4a51-4c1e-9d0a-3f0c8d5e7a11@hellositeline.test>"]);
    expect(m.from).toBe("pat@brightsmiles.example");
    expect(m.subject).toBe("Re: Your site search, Bright Smiles Dental");
    expect(m.text).toContain("Tuesday afternoon works");
    expect(m.date).toMatch(/^2026-11-18T16:40:52/);
    expect(m.autoSubmitted).toBe(false);
    expect(m.dsn).toBeNull();
  });

  it("extracts the DSN status and recipient from a bounce", async () => {
    const m = await parseInbound(bytes(bounceEml));
    expect(m.dsn).toEqual({ status: "5.1.1", recipient: "owner@oldplumber.example" });
    expect(m.autoSubmitted).toBe(true);
  });

  it("huge message parses", async () => {
    const m = await parseInbound(bytes(hugeEml));
    expect(hugeEml.length).toBeGreaterThan(190_000);
    expect(m.text.length).toBeLessThanOrEqual(20000);
    expect(m.text.length).toBeGreaterThan(1000);
    expect(m.subject).toBe("Re: Long thread about site search");
  });

  it("garbage bytes parse to empty fields", async () => {
    const garbage = Uint8Array.from({ length: 512 }, (_, i) => (i * 37 + 11) % 256);
    for (const input of [garbage, new Uint8Array(0)]) {
      expect(await parseInbound(input)).toEqual({
        messageId: null, inReplyTo: null, references: [], from: "", subject: "", text: "",
        date: null, autoSubmitted: false, dsn: null,
      });
    }
  });
});

describe("classifyInbound", () => {
  it("plain reply is a reply", async () => {
    expect(await kindOf(replyEml)).toBe("reply");
  });

  it('"Stop" alone is stop', async () => {
    expect(await kindOf(stopEml)).toBe("stop");
  });

  it('"no thanks" is stop', async () => {
    expect(await kindOf(withBody("No thanks."))).toBe("stop");
    expect(await kindOf(withBody("Please remove me from your list"))).toBe("stop");
    expect(await kindOf(withBody("Don't email me again!"))).toBe("stop");
  });

  it('"Can you stop by tomorrow?" is a reply', async () => {
    expect(await kindOf(withBody("Can you stop by tomorrow?"))).toBe("reply");
  });

  it("quoted footer saying Reply stop is not a stop", async () => {
    const m = await parseInbound(bytes(footerEml));
    expect(m.text).toContain('Reply "stop" and I won\'t email again.');
    expect(classifyInbound(m)).toBe("reply");
  });

  it("dsn 5.1.1 is bounce_hard, 4.2.2 is bounce_soft", async () => {
    expect(await kindOf(bounceEml)).toBe("bounce_hard");
    expect(await kindOf(bounceEml.replace("Status: 5.1.1", "Status: 4.2.2"))).toBe("bounce_soft");
  });

  it("out of office is auto_reply", async () => {
    expect(await kindOf(oooEml)).toBe("auto_reply");
    const bySubject = oooEml.replace("Auto-Submitted: auto-replied\n", "").replace("Automatic reply:", "Out of office:");
    expect(await kindOf(bySubject)).toBe("auto_reply");
  });

  it("Auto-Submitted: no does not make an auto reply", async () => {
    const m = await parseInbound(bytes(replyEml.replace("MIME-Version: 1.0", "Auto-Submitted: no\nMIME-Version: 1.0")));
    expect(m.autoSubmitted).toBe(false);
    expect(classifyInbound(m)).toBe("reply");
  });

  it("a non-failure DSN is never a reply", async () => {
    expect(await kindOf(bounceEml.replace("Status: 5.1.1", "Status: 2.0.0"))).toBe("auto_reply");
  });
});

describe("stripQuoted", () => {
  it("drops > lines and everything after an On ... wrote: line", () => {
    expect(stripQuoted("Yes\n> old\nMore\nOn Tue, Nov 17, 2026 at 9:02 AM Logan <a@b.test> wrote:\n> x\nafter")).toBe("Yes\nMore");
  });

  it("handles a wrapped On ... wrote: line", () => {
    expect(stripQuoted("Sure\n\nOn Tue, Nov 17, 2026 at 9:02 AM Logan Irish <outreach@hellositeline.test>\nwrote:\n> hi")).toBe("Sure");
  });

  it("drops everything after an Original Message line", () => {
    expect(stripQuoted("Ok\n-----Original Message-----\nFrom: x\nstop")).toBe("Ok");
  });
});
