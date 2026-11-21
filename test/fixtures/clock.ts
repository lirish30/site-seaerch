/**
 * A clock that starts at `at` and moves on one millisecond every time it is read, so rows made one after another keep their order (a frozen fake clock gives them all the same time,
 * and then a random id decides). Returns the function that puts the real clock back.
 */
export function tickingClock(at: Date): () => void {
  const Real = Date;
  let t = at.getTime();
  class TickDate extends Real {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(t++);
      else super(...(args as [string | number | Date]));
    }
    static now(): number { return t++; }
  }
  globalThis.Date = TickDate as DateConstructor;
  return () => { globalThis.Date = Real; };
}
