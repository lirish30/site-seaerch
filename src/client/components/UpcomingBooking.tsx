import { useEffect, useState } from "react";
import { api } from "../api";
import { formatSlot, safeMeetUrl } from "../bookingView";
import Icon from "./Icon";

interface Upcoming {
  id: string; startAt: string; endAt: string; kind: string; contactName: string; contactEmail: string; contactPhone: string | null;
  meetUrl: string | null; budgetLabel: string;
  answers: { topic: string; budgetId: string; timeline: string; decisionMaker: "me" | "me_and_other" } | null;
}

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * The lead's next confirmed call: when, the Meet link, who booked it and what they answered. Nothing when there is none. Everything the guest typed is
 * shown as text (React escapes it); none of it is ever rendered as HTML or put into a link except the validated email address.
 */
export default function UpcomingBooking({ leadId }: { leadId: string }) {
  const [booking, setBooking] = useState<Upcoming | null>(null);
  useEffect(() => {
    let live = true;
    setBooking(null);
    api.get<Upcoming[]>(`/bookings?lead=${encodeURIComponent(leadId)}`).then((all) => { if (live) setBooking(all[0] ?? null); }).catch(() => { if (live) setBooking(null); });
    return () => { live = false; };
  }, [leadId]);
  if (!booking) return null;
  const meet = safeMeetUrl(booking.meetUrl), a = booking.answers;
  return (
    <details className="prop-sec" open>
      <summary><Icon name="calendar" size={15} /><span className="grow">Booked call</span><Icon name="chevron-down" size={14} className="chev" /></summary>
      <div className="prop-body">
        <div className="kv"><span className="k">When</span><span className="v">{formatSlot(booking.startAt, zone())}</span></div>
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
