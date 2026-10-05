import { describe, it, expect } from "vitest";
import { matchBusiness, type ImportRow } from "../src/worker/import/match";
import { namesSimilar, normalizeName } from "../src/worker/import/names";
import { parseCsv, ImportLimitError, MAX_IMPORT_ROWS } from "../src/worker/import/parse";
import type { Business } from "../src/worker/types";

const biz = (id: string, name: string, website: string | null, o: Partial<Business> = {}): Business => ({
  id, place_id: null, domain: website ? new URL(website.startsWith("http") ? website : `https://${website}`).hostname.replace(/^www\./, "") : null,
  name, category: null, address: null, phone: null, website_url: website, maps_url: null, rating: null, review_count: null,
  first_seen_search_id: null, lead_status: "new", notes: null, contacted_at: null, last_error: null, created_at: "2026-01-01",
  archived_at: null, follow_up_at: null, deal_value: null, scan_stage: "full", tags: [], starred_at: null, ...o,
});
const row = (name: string, url: string | null, o: Partial<ImportRow> = {}): ImportRow => ({ name, url, source: "Referral", ...o });

describe("name similarity", () => {
  it("ignores case, punctuation, spacing and '&' vs 'and'", () => {
    expect(normalizeName("Smith & Sons, Inc.")).toBe(normalizeName("SMITH and SONS inc"));
    expect(namesSimilar("A.C.E. Plumbing", "ace plumbing")).toBe(true);
  });
  it("accepts containment only when both names are at least 4 characters", () => {
    expect(namesSimilar("Acme", "Acme Roofing LLC")).toBe(true);
    expect(namesSimilar("A", "Acme Roofing")).toBe(false);
    expect(namesSimilar("Ace", "Ace Plumbing")).toBe(false);
    expect(namesSimilar("", "Acme")).toBe(false);
  });
  it("treats different names as different", () => {
    expect(namesSimilar("Acme Roofing", "Birch Dental")).toBe(false);
  });
});

describe("matchBusiness", () => {
  // The brief's example host x.com is Twitter, which is on the social-only list, so a stand-in domain is used.
  it("http://www.xco.com/ vs https://xco.com with the same name is an exact match", () => {
    const ex = biz("1", "X Plumbing", "https://xco.com");
    const m = matchBusiness(row("X Plumbing", "http://www.xco.com/"), [ex]);
    expect(m.kind).toBe("exact");
    expect(m.candidates).toEqual([ex]);
  });
  it("same domain but a clearly different name is ambiguous", () => {
    const ex = biz("1", "Birch Dental", "https://xco.com");
    const m = matchBusiness(row("Acme Roofing", "https://xco.com"), [ex]);
    expect(m).toEqual({ kind: "ambiguous", candidates: [ex] });
  });
  it("same name on a different domain is ambiguous", () => {
    const ex = biz("1", "Acme Roofing", "https://acme.com");
    const m = matchBusiness(row("acme roofing", "https://other-acme.net"), [ex]);
    expect(m).toEqual({ kind: "ambiguous", candidates: [ex] });
  });
  it("same name when the existing lead has no website is ambiguous", () => {
    const ex = biz("1", "Acme Roofing", null);
    expect(matchBusiness(row("Acme Roofing", "https://acme.com"), [ex]).kind).toBe("ambiguous");
  });
  it("two matching candidates are ambiguous and both are returned", () => {
    const a = biz("1", "Acme Roofing", "https://acme.com");
    const b = biz("2", "Acme Roofing", "https://acme-roofing.net");
    const m = matchBusiness(row("Acme Roofing", "https://acme.com"), [a, b]);
    expect(m.kind).toBe("ambiguous");
    expect(m.candidates.map((x) => x.id).sort()).toEqual(["1", "2"]);
  });
  it("x.com (Twitter) is a social host, so it is never a domain match even for the same name", () => {
    const ex = biz("1", "X Plumbing", "https://x.com");
    expect(matchBusiness(row("Other Co", "https://www.x.com/"), [ex])).toEqual({ kind: "new", candidates: [] });
  });
  it("a social-only URL never matches by domain", () => {
    const ex = biz("1", "Birch Dental", "https://facebook.com/birch");
    expect(ex.domain).toBe("facebook.com"); // an old row that predates the social-host rule
    const m = matchBusiness(row("Acme Roofing", "https://www.facebook.com/acme"), [ex]);
    expect(m).toEqual({ kind: "new", candidates: [] });
  });
  it("a social-only URL still matches an existing business by name (ambiguous, never exact)", () => {
    const ex = biz("1", "Acme Roofing", "https://acme.com");
    expect(matchBusiness(row("Acme Roofing", "https://facebook.com/acme"), [ex]).kind).toBe("ambiguous");
  });
  it("no website and no name match is new", () => {
    expect(matchBusiness(row("Acme Roofing", null), [biz("1", "Birch Dental", "https://birch.com")])).toEqual({ kind: "new", candidates: [] });
    expect(matchBusiness(row("Acme Roofing", null), [])).toEqual({ kind: "new", candidates: [] });
  });
  it("a row with no website matched only by name is ambiguous, never exact", () => {
    const ex = biz("1", "Acme Roofing", "https://acme.com");
    expect(matchBusiness(row("Acme Roofing", null), [ex])).toEqual({ kind: "ambiguous", candidates: [ex] });
  });
  it("a different domain and a different name is new", () => {
    expect(matchBusiness(row("Acme Roofing", "https://acme.com"), [biz("1", "Birch Dental", "https://birch.com")]).kind).toBe("new");
  });
  it("matches an existing lead through its website when the domain column is empty", () => {
    const ex = biz("1", "Acme Roofing", "https://www.acme.com/contact", { domain: null });
    expect(matchBusiness(row("Acme Roofing", "acme.com"), [ex]).kind).toBe("exact");
  });
  it("is pure: it does not reorder or mutate its input", () => {
    const list = [biz("1", "Acme Roofing", "https://acme.com")];
    const copy = structuredClone(list);
    matchBusiness(row("Acme Roofing", "https://acme.com"), list);
    expect(list).toEqual(copy);
  });
});

describe("parseCsv", () => {
  it("reads name, website, address, phone and category", () => {
    const [r] = parseCsv("name,website,address,phone,category\nAcme Roofing,https://acme.com,1 Main St,555-1234,Roofer", "Referral");
    expect(r).toEqual({ line: 2, row: { name: "Acme Roofing", url: "https://acme.com", address: "1 Main St", phone: "555-1234", category: "Roofer", source: "Referral" } });
  });
  it("accepts url or site for the website column, in any case", () => {
    expect(parseCsv("Name,URL\nA Co,a.com")[0].row.url).toBe("a.com");
    expect(parseCsv("NAME,Site\nA Co,a.com")[0].row.url).toBe("a.com");
    expect(parseCsv("name,website\nA Co,a.com")[0].row.url).toBe("a.com");
  });
  it("handles quoted commas, escaped quotes and newlines inside quotes", () => {
    const rows = parseCsv('name,website,address\n"Smith, Jones & Co",a.com,"1 ""Main"" St\nSuite 2"');
    expect(rows[0].row.name).toBe("Smith, Jones & Co");
    expect(rows[0].row.address).toBe('1 "Main" St\nSuite 2');
  });
  it("handles CRLF, a UTF-8 BOM and blank lines", () => {
    const rows = parseCsv("﻿name,website\r\nA Co,a.com\r\n\r\n  \r\nB Co,b.com\r\n");
    expect(rows.map((r) => r.row.name)).toEqual(["A Co", "B Co"]);
    expect(rows.map((r) => r.line)).toEqual([2, 5]);
  });
  it("reports a row without a name as an error entry instead of throwing", () => {
    const rows = parseCsv("name,website\n,a.com\nB Co,b.com");
    expect(rows).toHaveLength(2);
    expect(rows[0].error).toMatch(/name/i);
    expect(rows[0].row.url).toBe("a.com");
    expect(rows[1].error).toBeUndefined();
  });
  it("turns empty cells into null and trims values", () => {
    const [r] = parseCsv("name,website,phone\n  A Co  ,, ");
    expect(r.row).toMatchObject({ name: "A Co", url: null, phone: null });
  });
  it("tolerates short rows and ignores unknown columns", () => {
    const [r] = parseCsv("name,notes,website\nA Co");
    expect(r.row).toMatchObject({ name: "A Co", url: null });
  });
  it("throws a friendly error when there is no name column", () => {
    expect(() => parseCsv("website,phone\na.com,555")).toThrow(/name/i);
    expect(() => parseCsv("")).toThrow(/empty|header/i);
  });
  it("refuses more than the row cap and more than 1 MB of text", () => {
    const many = ["name"].concat(Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `B${i}`)).join("\n");
    expect(() => parseCsv(many)).toThrow(ImportLimitError);
    expect(() => parseCsv("name\n" + "x".repeat(1_048_577))).toThrow(ImportLimitError);
    expect(parseCsv(["name"].concat(Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => `B${i}`)).join("\n"))).toHaveLength(MAX_IMPORT_ROWS);
  });
});
