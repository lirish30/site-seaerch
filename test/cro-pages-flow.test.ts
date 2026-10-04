import { describe, it, expect } from "vitest";
import { BIZ_MODELS, modelsText } from "../src/worker/cro/models";
import { CATALOG, catalogById, catalogFits, catalogText } from "../src/worker/cro/catalog";
import { BIZ_MODEL_KEYS, REC_AREAS } from "../src/worker/cro/types";
import { selectPages } from "../src/worker/cro/pages";
import { followable, loadFailed, pickPrimaryCta, vendorOf } from "../src/worker/cro/flow";
import { detectMartech } from "../src/worker/cro/martech";
import { PROBE_SCRIPT, FLOW_PROBE, AXE_RUN } from "../src/worker/cro/probe";
import { snapshot, box } from "./fixtures/cro";

describe("business models and catalog", () => {
  it("covers every model with a close rate in (0, 1]", () => {
    for (const k of BIZ_MODEL_KEYS) {
      expect(BIZ_MODELS[k].closeRate).toBeGreaterThan(0);
      expect(BIZ_MODELS[k].closeRate).toBeLessThanOrEqual(1);
    }
    expect(modelsText()).toContain("lead_gen_phone");
  });

  it("has at least 40 unique, well-formed catalog items", () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(40);
    expect(new Set(CATALOG.map((c) => c.id)).size).toBe(CATALOG.length);
    for (const c of CATALOG) expect(REC_AREAS).toContain(c.area);
  });

  it("filters by model", () => {
    expect(catalogFits("html_menu", "walk_in")).toBe(true);
    expect(catalogFits("html_menu", "lead_gen_phone")).toBe(false);
    expect(catalogFits("header_cta", "ecommerce")).toBe(true);
    expect(catalogFits("nope", "ecommerce")).toBe(false);
    expect(catalogById("guest_checkout")!.area).toBe("forms");
    expect(catalogText("walk_in")).toContain("html_menu");
    expect(catalogText("lead_gen_phone")).not.toContain("html_menu");
  });
});

describe("selectPages", () => {
  it("puts home first, then pages in conversion priority, deduped, same-site only, capped", () => {
    const pages = selectPages("https://ace.com", {
      about: "https://ace.com/about/", contact: "https://www.ace.com/contact", blog: "https://ace.com/blog",
      services: "https://ace.com/services#top", booking: "https://book.vagaro.com/ace", careers: "https://ace.com/jobs",
      portfolio: "https://ace.com/about", pricing: "https://ace.com/pricing", faq: "https://ace.com/faq", team: "https://ace.com/team",
    });
    expect(pages.map((p) => p.kind)).toEqual(["home", "contact", "services", "pricing", "about", "team", "faq"]);
    expect(pages[0].url).toBe("https://ace.com/");
    expect(pages).toHaveLength(7);
  });

  it("works with no links and adds a scheme when missing", () => {
    expect(selectPages("ace.com", {})).toEqual([{ url: "https://ace.com/", kind: "home" }]);
  });
});

describe("flow helpers", () => {
  it("follows only same-site links and known booking vendors", () => {
    const base = "https://ace.com/";
    expect(followable("/contact", base)).toBe("https://ace.com/contact");
    expect(followable("https://www.ace.com/quote", base)).toBe("https://www.ace.com/quote");
    expect(followable("https://book.vagaro.com/ace", base)).toBe("https://book.vagaro.com/ace");
    for (const bad of ["tel:2085551234", "mailto:a@b.com", "javascript:void(0)", "#", "#quote", "https://facebook.com/ace", null, "http://[bad"])
      expect(followable(bad, base)).toBeNull();
  });

  it("names booking vendors", () => {
    expect(vendorOf("https://calendly.com/ace/30min")).toBe("Calendly");
    expect(vendorOf("https://www.opentable.com/r/ace")).toBe("OpenTable");
    expect(vendorOf("https://ace.com/book")).toBeNull();
  });

  it("picks the header action button first, then the first action above the fold", () => {
    const cta = (text: string, o = {}) => ({ text, href: "/x", box: box(), aboveFold: true, inHeader: false, contrast: 5, fontPx: 16, ...o });
    expect(pickPrimaryCta(snapshot({ ctas: [cta("Learn more"), cta("Book Now"), cta("Get a Quote", { inHeader: true })] }))!.text).toBe("Get a Quote");
    expect(pickPrimaryCta(snapshot({ ctas: [cta("Learn more"), cta("Book Now")] }))!.text).toBe("Book Now");
    expect(pickPrimaryCta(snapshot({ ctas: [cta("Learn more")] }))).toBeNull();
    expect(pickPrimaryCta(snapshot({ ctas: [cta("Book Now", { aboveFold: false })] }))).toBeNull();
  });
});

describe("loadFailed", () => {
  it("treats a missing response or an HTTP error as a failed load", () => {
    for (const bad of [undefined, null, 400, 403, 404, 500, 503]) expect(loadFailed(bad)).toBe(true);
    for (const ok of [200, 204, 301, 304]) expect(loadFailed(ok)).toBe(false);
  });
});

describe("detectMartech", () => {
  it("detects tools from hosts, script URLs and globals", () => {
    const found = detectMartech({
      hosts: ["www.googletagmanager.com", "cdn.callrail.com"], scripts: ["https://static.wixstatic.com/x.js"], globals: ["fbq"],
    }).map((x) => x.name);
    expect(found).toEqual(expect.arrayContaining(["Google Tag Manager", "CallRail", "Wix", "Meta Pixel"]));
  });

  it("returns nothing for a bare site", () => {
    expect(detectMartech({ hosts: ["ace.com"], scripts: [], globals: [] })).toEqual([]);
  });
});

describe("probe scripts", () => {
  it("are plain expressions with no template interpolation leftovers", () => {
    for (const s of [PROBE_SCRIPT, FLOW_PROBE, AXE_RUN]) {
      expect(s.trim().startsWith("(")).toBe(true);
      expect(s).not.toContain("${");
    }
    expect(PROBE_SCRIPT).toContain("telLinks");
  });
});
