import { expect } from "vitest";

/** The path of every number in `value` that is NaN or infinite, so a test can name what broke. Walks objects and arrays. */
export function nonFinitePaths(value: unknown, path = "$"): string[] {
  if (typeof value === "number") return Number.isFinite(value) ? [] : [`${path} = ${value}`];
  if (Array.isArray(value)) return value.flatMap((v, i) => nonFinitePaths(v, `${path}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => nonFinitePaths(v, `${path}.${k}`));
  return [];
}

/** Every number in an object a function returned is finite. Do not run it on a parsed JSON string alone: JSON turns NaN and Infinity into null, which this cannot see. */
export function expectFiniteNumbers(value: unknown): void {
  expect(nonFinitePaths(value), "numbers that are not finite").toEqual([]);
}

/** The path of every number in `shape` that is not a finite number at the same place in `actual` (a JSON round trip turns NaN into null, so a lost number shows up here). A null or missing value in `shape` is not asked for. */
export function lostNumbers(actual: unknown, shape: unknown, path = "$"): string[] {
  if (typeof shape === "number") return typeof actual === "number" && Number.isFinite(actual) ? [] : [`${path}: expected a finite number, got ${JSON.stringify(actual) ?? "nothing"}`];
  if (Array.isArray(shape)) {
    const got = Array.isArray(actual) ? actual : [];
    return shape.flatMap((v, i) => lostNumbers(got[i], v, `${path}[${i}]`));
  }
  if (shape && typeof shape === "object") {
    const got = actual && typeof actual === "object" ? (actual as Record<string, unknown>) : {};
    return Object.entries(shape).flatMap(([k, v]) => lostNumbers(got[k], v, `${path}.${k}`));
  }
  return [];
}

/**
 * A parsed JSON response carries every number the function that built it returned, all finite (`reference` is that function's own result, which still has any NaN in it).
 * Both are checked: the reference has no NaN or Infinity, and every number in it came through the JSON as a real number.
 */
export function expectNumbersSurvive(parsedJson: unknown, reference: unknown): void {
  expectFiniteNumbers(reference);
  expectFiniteNumbers(parsedJson);
  expect(lostNumbers(parsedJson, reference), "numbers lost on the way out").toEqual([]);
}
