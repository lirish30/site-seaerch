import type { Fetch } from "../google/oauth";

interface BookingDeps { fetch: Fetch }

const defaults = (): BookingDeps => ({ fetch: (url, init) => fetch(url, init) });
let current: BookingDeps = defaults();

/** The fetch every Google Calendar call in the booking flow goes through. */
export const getBookingFetch = (): Fetch => current.fetch;

/** Tests only: stand in for Google; null restores the real fetch. */
export function setBookingDeps(d: Partial<BookingDeps> | null): void {
  current = d ? { ...defaults(), ...d } : defaults();
}
