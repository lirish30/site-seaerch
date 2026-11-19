import { describe, it, expect } from "vitest";
import { escapeHtml, parseSignature, renderSignatureHtml, renderSignatureText, safeImageUrl, safeUrl } from "../src/worker/email/signature";
import { bodyToHtml, composeEmail, footerLines } from "../src/worker/email/render";
import type { Settings, Signature } from "../src/worker/types";

const sig: Signature = {
  name: "Logan Irish", title: "Front-end developer", email: "logan@x.com", phone: "208-555-0100", website: "https://logan.dev",
  links: [{ label: "GitHub", url: "https://github.com/logan" }, { label: "Resume", url: "https://logan.dev/resume.pdf" }],
  image_url: "https://logan.dev/logo.png", image_link: "https://logan.dev", image_width: 96,
};
const base = {
  your_name: "Logan Irish", business_name: "", contact_email: "", services_blurb: "", signature: "Logan Irish\nIrish Web",
  physical_address: "123 Main St, Boise, ID 83702", opt_out_line: "Reply 'no thanks' and I won't follow up.", tone_notes: "",
  monthly_spend_limit_usd: 25, tone_preset: "friendly_local", email_length: "short", cta_style: "mini_audit", logo_url: "",
  role_title: "", bio: "", availability: "", resume_url: "", goal_line: "", signature_json: "",
} as Settings;
const dec = (s: string) => Buffer.from(s.replace(/\r\n/g, ""), "base64").toString();

describe("safeUrl", () => {
  it("accepts http(s), adds https to a bare domain, and drops everything else", () => {
    expect(safeUrl("https://logan.dev/a?b=1")).toBe("https://logan.dev/a?b=1");
    expect(safeUrl("logan.dev")).toBe("https://logan.dev/");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://x.com", "mailto:a@b.com", "not a url", "", "https://exa mple.com"]) expect(safeUrl(bad), bad).toBe("");
  });
  it("images must be https", () => {
    expect(safeImageUrl("https://x.com/a.png")).toBe("https://x.com/a.png");
    expect(safeImageUrl("http://x.com/a.png")).toBe("");
  });
});

describe("parseSignature", () => {
  it("round-trips a clean signature", () => {
    expect(parseSignature(JSON.stringify(sig))).toMatchObject({ name: "Logan Irish", image_url: "https://logan.dev/logo.png", links: [{ label: "GitHub" }, { label: "Resume" }] });
  });
  it("is null for empty, invalid or blank data and never throws", () => {
    for (const v of ["", "  ", "{not json", "null", "[]", JSON.stringify({ name: "  ", links: [] })]) expect(parseSignature(v), v).toBeNull();
    expect(parseSignature(undefined)).toBeNull();
  });
  it("drops unsafe links and images, clamps the image width, and caps the links", () => {
    const s = parseSignature(JSON.stringify({
      name: "L", image_url: "http://x.com/a.png", image_width: 9000,
      links: [{ label: "bad", url: "javascript:alert(1)" }, ...Array.from({ length: 12 }, (_, i) => ({ label: `L${i}`, url: `https://x.com/${i}` }))],
    }))!;
    expect(s.image_url).toBe("");
    expect(s.image_width).toBe(300);
    expect(s.links.length).toBeLessThanOrEqual(8);
    expect(s.links.every((l) => l.url.startsWith("https://"))).toBe(true);
  });
});

describe("signature rendering", () => {
  // The renderers receive the cleaned form, as they do in the app.
  const clean = parseSignature(JSON.stringify(sig))!;
  it("renders a table with the image, name, title, contact line and links", () => {
    const html = renderSignatureHtml(clean);
    expect(html).toMatch(/^<table /);
    expect(html).toContain('<img src="https://logan.dev/logo.png"');
    expect(html).toContain('width="96"');
    expect(html).toContain('<a href="https://logan.dev/">');
    expect(html).toContain("Logan Irish");
    expect(html).toContain("Front-end developer");
    expect(html).toContain('href="mailto:logan@x.com"');
    expect(html).toContain('href="https://github.com/logan"');
  });
  it("omits the image cell when there is no image", () => {
    expect(renderSignatureHtml({ ...clean, image_url: "" })).not.toContain("<img");
  });
  it("escapes everything the sender typed", () => {
    const html = renderSignatureHtml({ ...clean, name: '<script>alert("x")</script>', title: "A & B" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("A &amp; B");
    expect(escapeHtml(`<'">&`)).toBe("&lt;&#39;&quot;&gt;&amp;");
  });
  it("renders plain text with one line per fact", () => {
    expect(renderSignatureText(clean)).toBe([
      "Logan Irish", "Front-end developer", "logan@x.com · 208-555-0100 · logan.dev", "GitHub: https://github.com/logan", "Resume: https://logan.dev/resume.pdf",
    ].join("\n"));
  });
});

describe("bodyToHtml", () => {
  it("makes paragraphs, keeps line breaks, escapes markup and links bare URLs", () => {
    const h = bodyToHtml("Hi <b>Ann</b>,\nsecond line\n\nSee https://logan.dev/work?a=1&b=2.");
    expect(h.match(/<p /g)).toHaveLength(2);
    expect(h).toContain("Hi &lt;b&gt;Ann&lt;/b&gt;,<br>second line");
    expect(h).toContain('<a href="https://logan.dev/work?a=1&amp;b=2" style="color:#1a56db">https://logan.dev/work?a=1&amp;b=2</a>.');
  });
});

describe("composeEmail", () => {
  const draft = { subject: "Hello", body: "Hi Ann,\n\nA short note.\n\nLogan", include_footer: false };

  it("puts the signature after the body and leaves the footer off when the draft opts out", () => {
    const e = composeEmail({ ...base, signature_json: JSON.stringify(sig) }, draft);
    expect(e.text).toBe(`Hi Ann,\n\nA short note.\n\nLogan\n\n${renderSignatureText(parseSignature(JSON.stringify(sig))!)}`);
    expect(e.text).not.toContain("123 Main St");
    expect(e.html).toContain("<table");
    expect(e.html).not.toContain("123 Main St");
  });

  it("adds the address and opt-out line when the draft asks for them", () => {
    const e = composeEmail(base, { ...draft, include_footer: true });
    expect(e.text.endsWith("123 Main St, Boise, ID 83702\nReply 'no thanks' and I won't follow up.")).toBe(true);
    expect(e.html).toContain("Reply &#39;no thanks&#39; and I won&#39;t follow up.");
  });

  it("falls back to the plain-text signature when no builder signature is set", () => {
    const e = composeEmail(base, draft);
    expect(e.text).toContain("Logan Irish\nIrish Web");
    expect(e.html).toContain("Logan Irish<br>Irish Web");
  });

  it("does not repeat a footer line the body already contains (older drafts)", () => {
    const old = { ...draft, include_footer: true, body: "Hi\n\n123 Main St, Boise, ID 83702\nReply 'no thanks' and I won't follow up." };
    const e = composeEmail(base, old);
    expect(e.text.match(/123 Main St/g)).toHaveLength(1);
    expect(footerLines(base, old.body, true)).toEqual([]);
  });

  it("skips blank footer fields and an empty signature", () => {
    const e = composeEmail({ ...base, signature: "", physical_address: "", opt_out_line: "" }, { ...draft, include_footer: true });
    expect(e.text).toBe("Hi Ann,\n\nA short note.\n\nLogan");
  });
});

describe("composeEmail hero", () => {
  const hero = { src: "https://go.x.test/api/public/report/tok/media/preview.gif", href: "https://go.x.test/r/tok", alt: "Video audit for Acme" };
  const draft = { subject: "Hi", body: "Hi Dana,\n\nI made a video.", include_footer: true };

  it("no hero gives identical output", () => {
    const plain = composeEmail(base, draft);
    expect(composeEmail(base, { ...draft, hero: undefined })).toEqual(plain);
    expect(plain.html).not.toContain("<img");
    expect(plain.text).not.toContain("Watch it here");
  });

  it("hero image sits after the body and before the signature", () => {
    const { html } = composeEmail({ ...base, signature_json: JSON.stringify(sig) }, { ...draft, hero });
    const img = html.indexOf(`<img src="${hero.src}"`);
    expect(img).toBeGreaterThan(html.indexOf("I made a video."));
    expect(img).toBeLessThan(html.indexOf("Logan Irish"));
    expect(html).toContain(`<a href="${hero.href}"`);
    expect(html).toContain('width="480"');
    expect(html).toContain('alt="Video audit for Acme"');
  });

  it("plain text carries the watch line", () => {
    const { text } = composeEmail(base, { ...draft, hero });
    expect(text).toBe(`Hi Dana,\n\nI made a video.\n\nWatch it here: ${hero.href}\n\nLogan Irish\nIrish Web\n\n123 Main St, Boise, ID 83702\nReply 'no thanks' and I won't follow up.`);
  });

  it("alt text is escaped", () => {
    const { html } = composeEmail(base, { ...draft, hero: { ...hero, alt: `Video audit for "Bob" <b>& Sons'` } });
    expect(html).toContain('alt="Video audit for &quot;Bob&quot; &lt;b&gt;&amp; Sons&#39;"');
    expect(html).not.toContain("<b>");
  });
});
