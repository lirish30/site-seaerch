import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "../../api";
import { bucketCounts, type Bucket } from "../../projectView";
import { PROJECTS_CHANGED, type ProjectRow } from "../../workData";
import { SideItem, SideTitle } from "./parts";

/** Projects: the lists by state (with counts), Billing, Money and the timesheet. The counts reload when a project is paused, resumed or cancelled, and when you move to another page. */
export default function WorkSidebar() {
  const { pathname, search } = useLocation();
  const [counts, setCounts] = useState<Record<Bucket, number> | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.get<{ projects: ProjectRow[] }>("/projects").then((r) => { if (live) setCounts(bucketCounts(r.projects)); }).catch(() => { if (live) setCounts(null); });
    load();
    window.addEventListener(PROJECTS_CHANGED, load);
    return () => { live = false; window.removeEventListener(PROJECTS_CHANGED, load); };
  }, [pathname]);
  const params = new URLSearchParams(search);
  const onList = pathname === "/projects" && !params.get("businessId"); // one lead's projects is none of the lists
  const view = params.get("view") ?? "active";
  return (
    <>
      <SideTitle title="Projects" />
      <SideItem to="/projects" icon="briefcase" label="Active" count={counts?.active} active={onList && view !== "waiting" && view !== "paused" && view !== "done"} />
      <SideItem to="/projects?view=waiting" icon="clock" label="Waiting on client" count={counts?.waiting} active={onList && view === "waiting"} />
      <SideItem to="/projects?view=paused" icon="ban" label="Paused" count={counts?.paused} active={onList && view === "paused"} />
      <SideItem to="/projects?view=done" icon="check" label="Done" count={counts?.done} active={onList && view === "done"} />
      <div className="side-spacer" />
      <SideItem to="/clients" icon="users" label="Clients" active={pathname === "/clients"} />
      <SideItem to="/billing" icon="card" label="Billing" active={pathname === "/billing"} />
      <SideItem to="/money" icon="trending" label="Money" active={pathname === "/money"} />
      <SideItem to="/timesheet" icon="calendar" label="Timesheet" active={pathname === "/timesheet"} />
      <div className="side-gap" aria-hidden="true" />
    </>
  );
}
