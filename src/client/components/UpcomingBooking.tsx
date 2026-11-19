import { useEffect, useState } from "react";
import { api } from "../api";
import { formatSlot, safeMeetUrl } from "../bookingView";
import BookingActions from "./BookingActions";
import Icon from "./Icon";

interface Upcoming {
  id: string; startAt: string; endAt: string; kind: "discovery" | "recommendation"; dealId: string | null; contactName: string; contactEmail: string; contactPhone: string | null;
  meetUrl: string | null; budgetLabel: string;
  answers: { topic: string; budgetId: string; timeline: string; decisionMaker: "me" | "me_and_other" } | null;
}

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

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
  const meet = safeMeetUrl(booking.meetUrl), a = booking.answers;
  return (
    <details className="prop-sec" open>
      <summary><Icon name="calendar" size={15} /><span className="grow">{booking.kind === "recommendation" ? "Booked meeting" : "Booked call"}</span><Icon name="chevron-down" size={14} className="chev" /></summary>
      <div className="prop-body">
        <div className="kv"><span className="k">When</span><span className="v">{formatSlot(booking.startAt, zone())}</span></div>
        <div className="kv"><span className="k">Outcome</span><span className="v"><BookingActions booking={booking} onChanged={onChanged} /></span></div>
        {meet && <div className="kv"><span className="k">Meet</span><span className="v"><a href={meet} target="_blank" rel="noreferrer">Open the Meet link</a></span></div>}
        <div className="kv wrap"><span className="k">Who</span><span className="v">{booking.contactName}</span></div>
        <div className="kv"><span className="k">Email</span><span className="v"><a href={`mailto:${booking.contactEmail}`}>{booking.contactEmail}</a></span></div>
        {booking.contactPhone && <div className="kv"><span className="k">Phone</span><span className="v">{booking.contactPhone}</span></div>}
        {a && <>
          <div className="kv wrap"><span className="k">Topic</span><span className="v">{a.topic}</span></div>
          <div className="kv"><span className="k">Budget</span><span className="v">{booking.budgetLabel}</span></div>
          <div className="kv"><span className="k">Timeline</span><span className="v">{a.timeline}</span></div>
          <div className="kv"><span className="k">Decides</span><span className="v">{a.decisionMaker === "me" ? "Just them" : "Them and someone else"}</span></div>
        </>}
      </div>
    </details>
  );
}
