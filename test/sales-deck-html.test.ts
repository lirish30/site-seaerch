import { describe, it, expect } from "vitest";
import { renderDeckHtml } from "../src/worker/sales/deckHtml";
import type { DeckSlide } from "../src/worker/sales/deck";

const snapshot = { key: "quick_fix", version: 1, name: "Quick Fix", kind: "one_time", priceCents: 79700, setupCents: 0, termMonths: null, fromPrice: false } as const;
const slides: DeckSlide[] = [
  { key: "title", title: "Ace Plumbing", blocks: [{ type: "text", text: "Website review", style: "eyebrow" }, { type: "text", text: "Prepared for Pat", style: "lead" }], speakerNote: "Open warmly.\n\nConfirm the time." },
  { key: "found", title: "Three things I found.", blocks: [
    { type: "image", dataUri: "data:image/jpeg;base64,AAAA", alt: "shot", label: "01", title: "No tap to call", text: "People leave." },
    { type: "image", dataUri: null, alt: "none", title: "Old footer", text: "Looks old." },
  ], speakerNote: "Same three as the video." },
  { key: "quick_fix", title: "Quick Fix.", blocks: [{ type: "price", text: "$797", snapshot }, { type: "list", items: [{ text: "One" }, { title: "Two", text: "more" }], numbered: true }, { type: "stat", value: "5", label: "jobs" }], speakerNote: "Say the price." },
];
const countOf = (h: string, re: RegExp) => (h.match(re) ?? []).length;

describe("renderDeckHtml", () => {
  it("escapes business names with markup", () => {
    const evil: DeckSlide[] = [{ key: "title", title: `<script>alert(1)</script> & "Sons'`, blocks: [
      { type: "text", text: `<img src=x onerror=alert(1)>` },
      { type: "image", dataUri: `javascript:alert(1)`, alt: `"><b>`, title: `<b>t</b>`, text: `<i>x</i>` },
      { type: "list", items: [{ title: "<u>a</u>", text: "<s>b</s>" }] },
    ], speakerNote: `<script>steal()</script>` }];
    for (const print of [false, true]) {
      const h = renderDeckHtml(evil, { title: `<title>x</title>`, print });
      expect(h).not.toContain("<script>alert(1)</script>");
      expect(h).not.toContain("<img src=x");
      expect(h).not.toContain("<script>steal()");
      expect(h).not.toContain("<b>t</b>");
      expect(h).not.toContain("javascript:");
      // The headline's last word sits in the accent span; the text around it is still escaped.
      expect(h).toContain(`&lt;script&gt;alert(1)&lt;/script&gt; &amp; <span class="sl-hl">&quot;Sons&#39;</span>`);
      expect(h).toContain("<title>&lt;title&gt;x&lt;/title&gt;</title>");
    }
    // The only script in the screen output is the deck's own.
    expect(countOf(renderDeckHtml(evil, { title: "t", print: false }), /<script>/g)).toBe(1);
  });

  it("print output has every slide and no notes", () => {
    const h = renderDeckHtml(slides, { title: "Ace", print: true });
    expect(countOf(h, /<section class="slide/g)).toBe(3);
    expect(h).not.toContain("Open warmly");
    expect(h).not.toContain("Say the price");
    expect(h).not.toContain('id="notes"');
    expect(h).not.toContain("<script");
    expect(h).toContain("page-break-after");
    expect(h).toContain("@page");
  });

  it("screen output has the speaker notes in a side panel and shows one slide at a time", () => {
    const h = renderDeckHtml(slides, { title: "Ace", print: false });
    expect(h).toContain('id="notes"');
    expect(h).toContain("Open warmly.");
    expect(h).toContain("<p>Confirm the time.</p>");
    expect(h).toContain(".slide{position:absolute");
    expect(countOf(h, /class="note"/g)).toBe(3);
  });

  it("output makes no external requests", () => {
    for (const print of [false, true]) {
      const h = renderDeckHtml(slides, { title: "Ace", print });
      expect(h).not.toMatch(/https?:\/\//);
      expect(h).not.toContain('src="//');
      expect(h).not.toMatch(/<link\b/i);
      expect(h).not.toMatch(/@import/);
      // The only url() is the embedded Geist font (a data: URI), never a request.
      expect(h).not.toMatch(/url\((?!data:font\/woff2;base64,)/);
      expect([...h.matchAll(/<img [^>]*src="([^"]*)"/g)].every((m) => m[1].startsWith("data:image/"))).toBe(true);
    }
  });

  it("arrow-key script is present on screen output only", () => {
    const screen = renderDeckHtml(slides, { title: "Ace", print: false });
    expect(screen).toContain("<script>");
    expect(screen).toContain("ArrowRight");
    expect(screen).toContain("ArrowLeft");
    expect(screen).toMatch(/"n"/);
    const print = renderDeckHtml(slides, { title: "Ace", print: true });
    expect(print).not.toContain("<script");
    expect(print).not.toContain("ArrowRight");
  });

  it("an image block with no picture still renders its text", () => {
    const h = renderDeckHtml(slides, { title: "Ace", print: true });
    expect(h).toContain("Old footer");
    expect(h).toContain('<div class="noimg">');
  });

  it("is set in the Siteline look: Geist embedded, paper and night slides, square corners", () => {
    const h = renderDeckHtml(slides, { title: "Ace - Recommendation", print: true });
    expect(h).toContain('font-family:"Geist"');
    expect(h).toContain("#f4f5ef");
    expect(h).toContain("#0c0f0e");
    expect(h).not.toMatch(/border-radius:\s*(?!0|50%)[1-9]/);
  });

  it("every inner slide has the running header and the page footer; the cover and the thank-you slide are set apart", () => {
    const deck: DeckSlide[] = [...slides, { key: "thanks", title: "Thank you.", blocks: [{ type: "text", text: "Logan  ·  logan@example.test", style: "lead" }], speakerNote: "Leave this up." }];
    const h = renderDeckHtml(deck, { title: "Ace Plumbing - Recommendation", print: true });
    expect(countOf(h, /<header class="sl-head">/g)).toBe(2);
    expect(h).toContain('<div class="sl-doc">Recommendation <span>/ Ace Plumbing</span></div>');
    expect(countOf(h, /<footer class="sl-foot">PAGE \d+ \/ &copy;\d{4} Siteline/g)).toBe(4);
    expect(h).toContain('class="slide k-thanks sl-dark"');
    expect(h).toContain("PAGE 4 /");
  });

  it("the cover sets 'what / prepared for / date' on separate lines and loses no words", () => {
    const cover: DeckSlide[] = [{ key: "title", title: "Ace Plumbing", blocks: [{ type: "text", text: "Website review", style: "eyebrow" }, { type: "text", text: "Website review and recommendation  ·  Prepared for Pat Jones  ·  November 2026", style: "lead" }], speakerNote: "" }];
    const h = renderDeckHtml(cover, { title: "Ace Plumbing - Recommendation", print: true });
    expect(h).toContain('<p class="t lead">Website review and recommendation</p>');
    expect(h).toContain('<p class="t prep">Prepared for Pat Jones</p>');
    expect(h).toContain('<p class="meta">November 2026</p>');
    expect(h).not.toContain('<header class="sl-head">');
  });

  it("a stat row, option cards and image cards keep their block markup; the recommended option has its badge", () => {
    const deck: DeckSlide[] = [{ key: "options", title: "Your options.", blocks: [
      { type: "option", id: "a", label: "Fix it", tagline: "t", recommended: false, items: [], upfront: "$797", monthly: null },
      { type: "option", id: "b", label: "Fix and keep it", tagline: "t", recommended: true, items: [], upfront: "$797", monthly: "$129/mo" },
      { type: "stat", value: "5", label: "jobs" }, { type: "stat", value: "$400", label: "job", op: "times" },
    ], speakerNote: "" }];
    const h = renderDeckHtml(deck, { title: "x", print: true });
    expect(countOf(h, /class="card sl-card opt/g)).toBe(2);
    expect(countOf(h, /Recommended<\/small>/g)).toBe(1);
    expect(h).toContain("$797 up front + $129/mo");
    expect(h).toContain('<div class="row stat n2">');
    expect(h).toContain("&times;");
  });
});
