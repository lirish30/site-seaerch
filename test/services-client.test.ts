import { describe, expect, it } from "vitest";
import { fromLines, groupByCategory, toLines } from "../src/client/services";
import type { Service } from "../src/client/types";

const svc = (key: string, category: string) => ({ id: key, key, name: key, category } as Service);

describe("services client helpers", () => {
  it("groups by category keeping first-seen order", () => {
    const g = groupByCategory([svc("a", "X"), svc("b", "Y"), svc("c", "X")]);
    expect(g.map((x) => [x.category, x.services.map((s) => s.key)])).toEqual([["X", ["a", "c"]], ["Y", ["b"]]]);
  });
  it("round-trips one item per line, dropping blanks", () => {
    expect(fromLines(" one \n\n two\n")).toEqual(["one", "two"]);
    expect(fromLines(toLines(["a", "b"]))).toEqual(["a", "b"]);
    expect(fromLines("")).toEqual([]);
  });
});
