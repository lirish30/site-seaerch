import { describe, expect, it } from "vitest";
import { slidesFor, renderSlideHtml, clip, BODY_MAX, STUDIO_SIZE, TITLE_MAX, type StudioCopy } from "../src/worker/studio/templates";
import { STUDIO_BRAND } from "../src/worker/studio/brand";

const copy = (n: number, over: Partial<StudioCopy> = {}): StudioCopy => ({
  headline: "Five fixes that win calls", caption: "A short caption.", tags: ["#plumbing"],
  slides: Array.from({ length: n }, (_, i) => ({ title: `Tip ${i + 1}`, body: `Body of tip ${i + 1}.` })), ...over,
});
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
/** The html with every data: URI taken out. */
const withoutData = (h: string) => h.replace(/data:[^"')\s]+/g, "");

describe("studio templates", () => {
  it("slidesFor audit_tip caps at 6 slides and starts with a cover and ends with a close", () => {
    const s = slidesFor("audit_tip", copy(9), {});
    expect(s).toHaveLength(6);
    expect(s[0].kind).toBe("cover");
    expect(s[0].title).toBe("Five fixes that win calls");
    expect(s.slice(1, 5).map((x) => x.kind)).toEqual(["tip", "tip", "tip", "tip"]);
    expect(s.slice(1, 5).map((x) => x.title)).toEqual(["Tip 1", "Tip 2", "Tip 3", "Tip 4"]);
    expect(s[5].kind).toBe("close");
    const short = slidesFor("audit_tip", copy(2), {});
    expect(short.map((x) => x.kind)).toEqual(["cover", "tip", "tip", "close"]);
    expect(slidesFor("audit_tip", copy(0), {}).map((x) => x.kind)).toEqual(["cover", "close"]);
  });

  it("a title with <script> and an ampersand is escaped in the html", () => {
    const html = renderSlideHtml({ kind: "tip", title: `Fix <script>alert(1)</script> & "more"`, body: `Use <b>bold</b> & it's fine` });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;more&quot;");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; it&#39;s fine");
  });

  it("before_after puts both data URIs in one slide", () => {
    const s = slidesFor("before_after", copy(1), { before: JPG, after: PNG });
    expect(s.map((x) => x.kind)).toEqual(["cover", "before_after"]);
    expect(s[1].before).toBe(JPG);
    expect(s[1].after).toBe(PNG);
    const html = renderSlideHtml(s[1]);
    expect(html).toContain(JPG);
    expect(html).toContain(PNG);
  });

  it("only data: image URIs reach an img tag", () => {
    const html = renderSlideHtml({ kind: "before_after", title: "t", body: "b", before: "https://evil.example/x.png", after: `data:image/png;base64,AAAA" onerror="x` });
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<img");
  });

  it("the html has no http(s) URL except data: URIs", () => {
    const slides = [
      ...slidesFor("audit_tip", copy(5), {}), ...slidesFor("before_after", copy(1), { before: JPG, after: PNG }), ...slidesFor("case_study", copy(3), {}),
    ];
    for (const s of slides) {
      const html = renderSlideHtml(s);
      expect(withoutData(html), s.kind).not.toMatch(/https?:\/\//i);
      expect(withoutData(html), s.kind).not.toMatch(/@import|<link|url\(\s*["']?https?/i);
      expect(html).toContain(`${STUDIO_SIZE.width}px`);
    }
    expect(STUDIO_SIZE).toEqual({ width: 1080, height: 1350 });
  });

  it("case_study is one slide", () => {
    const s = slidesFor("case_study", copy(3), {});
    expect(s).toHaveLength(1);
    expect(s[0].kind).toBe("case");
    expect(s[0].title).toBe("Five fixes that win calls");
    expect(s[0].body).toContain("Tip 1");
    expect(s[0].body).toContain("Body of tip 3.");
  });

  it("the brand placeholders are plain strings with system fonts only", () => {
    for (const v of Object.values(STUDIO_BRAND)) expect(typeof v).toBe("string");
    expect(STUDIO_BRAND.headingFont + STUDIO_BRAND.bodyFont).not.toMatch(/https?:|url\(/);
  });

  it("the css is overflow-safe: top-anchored slide, auto-margin wrapper, wrapping and line clamps", () => {
    const html = renderSlideHtml({ kind: "tip", title: "t", body: "b" });
    expect(html).toMatch(/\.slide\{[^}]*justify-content:flex-start/);
    expect(html).not.toMatch(/justify-content:center/);
    expect(html).toMatch(/\.fit\{[^}]*margin:auto 0/);
    expect(html).toMatch(/h1,p\{[^}]*overflow-wrap:anywhere/);
    expect(html).toMatch(/h1,p\{[^}]*min-width:0/);
    expect(html).toMatch(/-webkit-line-clamp:\d/);
    expect(html).toMatch(/\.slide\{[^}]*overflow:hidden/);
    // the image row shrinks instead of pushing text out
    expect(html).toMatch(/\.pair\{[^}]*flex:1;min-height:0/);
    expect(html).toMatch(/object-fit:cover/);
  });

  it("a 400-character title and a 2,000-character body come out capped with an ellipsis", () => {
    const long = copy(2, { headline: "H".repeat(400) });
    long.slides = [{ title: "T ".repeat(200), body: "word ".repeat(400) }, { title: "ok", body: "ok" }];
    for (const kind of ["audit_tip", "before_after", "case_study"] as const) {
      for (const s of slidesFor(kind, long, { before: JPG, after: PNG })) {
        expect(Array.from(s.title).length, `${kind} ${s.kind} title`).toBeLessThanOrEqual(TITLE_MAX);
        if (kind !== "case_study") expect(Array.from(s.body).length, `${kind} ${s.kind} body`).toBeLessThanOrEqual(BODY_MAX);
      }
    }
    const tip = slidesFor("audit_tip", long, {})[1];
    expect(tip.title.endsWith("\u2026")).toBe(true);
    expect(tip.body.endsWith("\u2026")).toBe(true);
    expect(slidesFor("audit_tip", long, {})[0].title).toBe(`${"H".repeat(TITLE_MAX - 1)}\u2026`);
    // short text is left alone
    expect(slidesFor("audit_tip", long, {})[2]).toMatchObject({ title: "ok", body: "ok" });
    // a case card's sections are each capped
    const card = slidesFor("case_study", long, {})[0];
    for (const para of card.body.split("\n\n")) expect(Array.from(para).length).toBeLessThanOrEqual(TITLE_MAX + 2 + BODY_MAX);
  });

  it("an unbroken 200-character token is still capped, and renderSlideHtml caps a slide that was not built by slidesFor", () => {
    const token = "x".repeat(200);
    const s = slidesFor("audit_tip", copy(1, { slides: [{ title: token, body: token }] }), {})[1];
    expect(s.title).toBe(`${"x".repeat(TITLE_MAX - 1)}\u2026`);
    expect(s.body).toBe(`${"x".repeat(BODY_MAX - 1)}\u2026`);
    const html = renderSlideHtml({ kind: "tip", title: token, body: token });
    expect(html).toContain(`<h1>${"x".repeat(TITLE_MAX - 1)}\u2026</h1>`);
    expect(html).toContain(`<p>${"x".repeat(BODY_MAX - 1)}\u2026</p>`);
    expect(html).not.toContain("x".repeat(BODY_MAX + 1));
    // no more than three paragraphs, each capped
    const many = renderSlideHtml({ kind: "case", title: "t", body: Array.from({ length: 6 }, (_, i) => `p${i}`).join("\n\n") });
    expect(many.match(/<p>/g)).toHaveLength(3);
  });

  it("clip cuts by whole characters and leaves short text alone", () => {
    expect(clip("  hello  ", 10)).toBe("hello");
    expect(clip("abcdef", 4)).toBe("abc\u2026");
    expect(clip("\u{1F600}".repeat(5), 3)).toBe("\u{1F600}\u{1F600}\u2026");
  });
});
