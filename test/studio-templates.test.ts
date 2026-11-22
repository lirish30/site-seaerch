import { describe, expect, it } from "vitest";
import { slidesFor, renderSlideHtml, STUDIO_SIZE, type StudioCopy } from "../src/worker/studio/templates";
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
});
