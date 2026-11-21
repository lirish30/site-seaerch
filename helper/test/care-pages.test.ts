import { describe, expect, it, vi } from "vitest";
import { compare, pageUrl, readPage, screenshot, toJpeg, verdictOf, type PageShot } from "../src/care/pages.ts";
import type { Exec } from "../src/exec.ts";

const shot = (o: Partial<PageShot> = {}): PageShot => ({ path: "/", status: 200, fatal: false, forms: 1, png: "/tmp/a.png", ...o });

describe("verdictOf", () => {
  it("is broken when a 2xx page turns 5xx, 404, 410 or unreachable", () => {
    expect(verdictOf(shot(), shot({ status: 500 }), 1)).toBe("broken");
    expect(verdictOf(shot(), shot({ status: 503 }), 1)).toBe("broken");
    expect(verdictOf(shot(), shot({ status: 404 }), 1)).toBe("broken");
    expect(verdictOf(shot(), shot({ status: 410 }), 1)).toBe("broken");
    expect(verdictOf(shot(), shot({ status: null }), 1)).toBe("broken");
  });
  it("is ok when the page was already missing or broken before", () => {
    expect(verdictOf(shot({ status: 404 }), shot({ status: 404 }), null)).toBe("ok");
    expect(verdictOf(shot({ status: 500 }), shot({ status: 500 }), null)).toBe("ok");
    expect(verdictOf(shot({ status: null }), shot({ status: null }), null)).toBe("ok");
  });
  it("is broken when the critical error text appears", () => {
    expect(verdictOf(shot(), shot({ fatal: true }), 1)).toBe("broken");
  });
  it("is broken when forms drop, ok when they stay or grow", () => {
    expect(verdictOf(shot({ forms: 2 }), shot({ forms: 1 }), 1)).toBe("broken");
    expect(verdictOf(shot({ forms: 2 }), shot({ forms: 3 }), 1)).toBe("ok");
  });
  it("is changed below 0.95 SSIM, ok at 0.95 and with no SSIM", () => {
    expect(verdictOf(shot(), shot(), 0.94)).toBe("changed");
    expect(verdictOf(shot(), shot(), 0.95)).toBe("ok");
    expect(verdictOf(shot(), shot(), null)).toBe("ok");
  });
  it("puts broken before changed", () => {
    expect(verdictOf(shot(), shot({ status: 500 }), 0.2)).toBe("broken");
  });
});

const bodyFetch = (chunks: () => AsyncGenerator<string>, status = 200, read: { n: number } = { n: 0 }): typeof fetch =>
  (async () => {
    const it = chunks();
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(c) { const r = await it.next(); if (r.done) c.close(); else { read.n += r.value.length; c.enqueue(enc.encode(r.value)); } },
      cancel() { void it.return?.(undefined); },
    });
    return new Response(stream, { status });
  }) as unknown as typeof fetch;
const text = (s: string) => bodyFetch(async function* () { yield s; });

describe("readPage", () => {
  it("counts forms case-insensitively and reads the status", async () => {
    expect(await readPage(text("<FORM a><form class=x><formal>"), "https://a.com/")).toEqual({ status: 200, fatal: false, forms: 3 });
  });
  it("flags the critical error text", async () => {
    const r = await readPage(text("<p>There has been a critical error on this website.</p>"), "https://a.com/");
    expect(r.fatal).toBe(true);
  });
  it("follows redirects with a timeout signal", async () => {
    const f = vi.fn(async () => new Response("x")) as unknown as typeof fetch;
    await readPage(f, "https://a.com/");
    const init = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1];
    expect(init.redirect).toBe("follow");
    expect(init.signal).toBeDefined();
  });
  it("stops reading at 2 MB", async () => {
    const read = { n: 0 };
    const chunk = "x".repeat(64 * 1024);
    const f = bodyFetch(async function* () { for (let i = 0; i < 80; i++) yield chunk; }, 200, read);
    const r = await readPage(f, "https://a.com/");
    expect(r.status).toBe(200);
    expect(read.n).toBeLessThan(5 * 1024 * 1024);
    expect(read.n).toBeLessThanOrEqual(2 * 1024 * 1024 + 2 * 64 * 1024);
  });
  it("gives status null on a throw", async () => {
    const f = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(await readPage(f, "https://a.com/")).toEqual({ status: null, fatal: false, forms: 0 });
  });
});

describe("screenshot", () => {
  it("passes the URL last, as argv", async () => {
    const exec = vi.fn<Exec>(async () => ({ stdout: "" }));
    expect(await screenshot(exec, "/chrome", "https://a.com/x", "/o.png")).toBe(true);
    const [file, args, opts] = exec.mock.calls[0];
    expect(file).toBe("/chrome");
    expect(args).toEqual(["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--window-size=1280,1600", "--virtual-time-budget=8000", "--screenshot=/o.png", "https://a.com/x"]);
    expect(opts?.timeoutMs).toBe(60_000);
  });
  it("is false on failure", async () => {
    expect(await screenshot(async () => { throw new Error("x"); }, "/c", "https://a.com", "/o.png")).toBe(false);
  });
});

describe("compare", () => {
  const ssimOut = "[Parsed_ssim_0 @ 0x1] SSIM Y:0.98 U:0.99 V:0.99 All:0.981234 (17.2)";
  it("parses SSIM from stderr and writes the diff image", async () => {
    const exec = vi.fn<Exec>(async (_f, args) => ({ stdout: "", stderr: args.includes("ssim") ? ssimOut : "" }));
    expect(await compare(exec, "ffmpeg", "/a.png", "/b.png", "/d.jpg")).toBe(0.981234);
    expect(exec).toHaveBeenCalledTimes(2);
    const diff = exec.mock.calls[1][1];
    expect(diff).toContain("blend=all_mode=difference,eq=contrast=3");
    expect(diff).toContain("-q:v");
    expect(diff[diff.length - 1]).toBe("/d.jpg");
  });
  it("is null when the exec rejects", async () => {
    expect(await compare(async () => { throw new Error("x"); }, "ffmpeg", "/a", "/b", "/d")).toBeNull();
  });
  it("is null when no SSIM is printed", async () => {
    expect(await compare(async () => ({ stdout: "", stderr: "nothing" }), "ffmpeg", "/a", "/b", "/d")).toBeNull();
  });
  it("is null when the diff step fails", async () => {
    let n = 0;
    const exec: Exec = async () => { if (n++ === 1) throw new Error("x"); return { stdout: "", stderr: ssimOut }; };
    expect(await compare(exec, "ffmpeg", "/a", "/b", "/d")).toBeNull();
  });
});

describe("toJpeg", () => {
  it("converts and reports failure", async () => {
    const exec = vi.fn<Exec>(async () => ({ stdout: "" }));
    expect(await toJpeg(exec, "ffmpeg", "/a.png", "/a.jpg")).toBe(true);
    expect(await toJpeg(async () => { throw new Error("x"); }, "ffmpeg", "/a.png", "/a.jpg")).toBe(false);
  });
});

describe("pageUrl", () => {
  it("joins to the site's origin", () => {
    expect(pageUrl("https://acme.com/shop", "/contact")).toBe("https://acme.com/contact");
    expect(pageUrl("https://acme.com/shop", "/")).toBe("https://acme.com/");
  });
  it("refuses other hosts and bad paths", () => {
    expect(() => pageUrl("https://acme.com/shop", "//evil.com/")).toThrow();
    expect(() => pageUrl("https://acme.com/shop", "http://evil.com")).toThrow();
    expect(() => pageUrl("https://acme.com/shop", "/a/../b")).toThrow();
    expect(() => pageUrl("https://acme.com/shop", "/a b")).toThrow();
    expect(() => pageUrl("https://acme.com/shop", "/a\\b")).toThrow();
  });
});
