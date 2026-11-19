import { describe, expect, it } from "vitest";
import { pdfOptions } from "../src/worker/render/render";

describe("htmlToPdf options", () => {
  it("htmlToPdf letter passes portrait letter options and slide keeps the deck size", () => {
    expect(pdfOptions("letter")).toEqual({
      format: "letter", landscape: false, margin: { top: "0.75in", right: "0.75in", bottom: "0.75in", left: "0.75in" }, preferCSSPageSize: false, printBackground: true,
    });
    const deck = { width: "1280px", height: "720px", preferCSSPageSize: true, printBackground: true };
    expect(pdfOptions("slide")).toEqual(deck);
    expect(pdfOptions()).toEqual(deck);
  });
});
