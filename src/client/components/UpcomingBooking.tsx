import { useEffect, useState } from "react";
import { api } from "../api";
import { formatSlot, safeMeetUrl } from "../bookingView";
import { bookingActions } from "../callsView";
import { initials } from "../scoreView";
import BookingActions from "./BookingActions";
import Icon from "./Icon";

interface Upcoming {
  id: string; startAt: string; endAt: string; kind: "discovery" | "recommendation"; dealId: string | null; contactName: string; contactEmail: string; contactPhone: string | null;
  meetUrl: string | null; budgetLabel: string;
  answers: { topic: string; budgetId: string; timeline: string; decisionMaker: "me" | "me_and_other" } | null;
}

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const DAY_MS = 86_400_000;
/** The calendar day of a moment in the owner's zone, as a day number, so "tomorrow" is counted in days and not in 24-hour blocks. */
const dayNo = (d: Date, tz: string) => Date.parse(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d)) / DAY_MS;

/** "Today", "Tomorrow", "In 3 days", "Happening now", "Finished": how far off the call is, with the chip tone to show it in. */
function whenWord(startAt: string, endAt: string, now: Date, tz: string): { text: string; tone: "signal" | "info" | "neutral" | "warning" } {
  const start = new Date(startAt), end = new Date(endAt);
  if (now >= end) return { text: "Finished", tone: "warning" };
  if (now >= start) return { text: "Happening now", tone: "signal" };
  const days = Math.round(dayNo(start, tz) - dayNo(now, tz));
  if (days <= 0) return { text: "Today", tone: "signal" };
  if (days === 1) return { text: "Tomorrow", tone: "info" };
  return { text: `In ${days} days`, tone: "neutral" };
}

/** "30 min", "1 hour", "90 min". */
const lengthOf = (minutes: number) => (minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}` : `${minutes} min`);

/**
 * The lead's confirmed calls: when, the Meet link, who booked each and what they answered, with what Logan can do next (cancel one to come, or say what
 * happened to one that started). Nothing when there are none. Everything the guest typed is shown as text (React escapes it); none of it is ever
 * rendered as HTML or put into a link except the validated email address.
 */
export default function UpcomingBooking({ leadId }: { leadId: string }) {
  const [bookings, setBookings] = useState<Upcoming[]>([]);
  const [reloads, setReloads] = useState(0);
  useEffect(() => { setBookings([]); }, [leadId]);
  useEffect(() => {
    let live = true;
    api.get<Upcoming[]>(`/bookings?lead=${encodeURIComponent(leadId)}`).then((all) => { if (live) setBookings(all); }).catch(() => { if (live) setBookings([]); });
    return () => { live = false; };
  }, [leadId, reloads]);
  return <>{bookings.map((booking) => <BookingCard key={booking.id} booking={booking} onChanged={() => setReloads((n) => n + 1)} />)}</>;
}

function BookingCard({ booking, onChanged }: { booking: Upcoming; onChanged: () => void }) {
  const tz = zone(), now = new Date();
  const meet = safeMeetUrl(booking.meetUrl), a = booking.answers;
  const start = new Date(booking.startAt);
  const month = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short" }).format(start);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).format(start);
  const [weekday, md, ...time] = formatSlot(booking.startAt, tz).split(", "); // "Mon", "Nov 23", "10:00 AM PST"
  const minutes = Math.max(0, Math.round((Date.parse(booking.endAt) - start.getTime()) / 60_000));
  const when = whenWord(booking.startAt, booking.endAt, now, tz);
  const started = bookingActions(booking.startAt, now).includes("no_show");
  const what = booking.kind === "recommendation" ? "Recommendation meeting" : "Discovery call";
  return (
    <details className="prop-sec clx-lead-bk" open>
      <summary><Icon name="calendar" size={15} /><span className="grow">{booking.kind === "recommendation" ? "Booked meeting" : "Booked call"}</span><span className={`clx-lead-chip ${when.tone}`}>{when.text}</span><Icon name="chevron-down" size={14} className="chev" /></summary>
      <div className="prop-body">
        <div className="clx-lead-when">
          <span className="clx-lead-date" aria-hidden="true"><small>{month}</small><b>{day}</b></span>
          <span className="clx-lead-when-text">
            <b>{[weekday, md].filter(Boolean).join(", ")}{time.length > 0 && ` · ${time.join(", ")}`}</b>
            <small>{what}{minutes > 0 ? ` · ${lengthOf(minutes)}` : ""}</small>
          </span>
        </div>
        {meet && !started && <a className="btn sm clx-lead-meet" href={meet} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Open the Meet link</a>}

        <div className="clx-lead-person">
          <span className="avatar-sm" aria-hidden="true">{initials(booking.contactName)}</span>
          <span className="clx-lead-person-text">
            <b>{booking.contactName}</b>
            <a href={`mailto:${booking.contactEmail}`}>{booking.contactEmail}</a>
            {booking.contactPhone && <span>{booking.contactPhone}</span>}
          </span>
        </div>

        {a && (
          <div className="clx-lead-answers" role="group" aria-label="What they told you when they booked">
            <p className="clx-lead-over">What they told you</p>
            <p className="clx-lead-topic">{a.topic}</p>
            <dl>
              {booking.budgetLabel && <div><dt>Budget</dt><dd>{booking.budgetLabel}</dd></div>}
              <div><dt>Timeline</dt><dd>{a.timeline}</dd></div>
              <div><dt>Decides</dt><dd>{a.decisionMaker === "me" ? "Just them" : "Them and someone else"}</dd></div>
            </dl>
          </div>
        )}

        <div className="clx-lead-bk-foot">
          <span>{started ? "How did it go?" : "Plans changed?"}</span>
          <BookingActions booking={booking} onChanged={onChanged} />
        </div>
      </div>
    </details>
  );
}
