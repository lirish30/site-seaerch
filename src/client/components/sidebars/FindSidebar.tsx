import { useLocation } from "react-router-dom";
import { shortName, useSearches } from "../../searchesData";
import Icon, { type IconName } from "../Icon";
import { SideItem, SideTitle } from "./parts";
import { Link } from "react-router-dom";

/** Find: New search, Search history, Radar, Import leads, then what's running (or, on New search, what ran recently). */
export default function FindSidebar() {
  const { pathname } = useLocation();
  const { searches, radars } = useSearches();
  const running = (searches ?? []).filter((s) => s.status === "running");
  const recent = (searches ?? []).slice(0, 4);
  const onNew = pathname === "/";
  const list = onNew ? recent : running;
  const icon = (s: { status: string }): IconName => (s.status === "running" ? "refresh" : s.status === "failed" ? "alert" : "check");
  return (
    <>
      <SideTitle title="Find" />
      <SideItem to="/" icon="plus" label="New search" active={onNew} />
      <SideItem to="/searches" icon="clock" label="Search history" count={searches?.length} active={pathname === "/searches" || (pathname.startsWith("/searches/") && !list.some((s) => pathname === `/searches/${s.id}`))} />
      <SideItem to="/radar" icon="radar" label="Radar" count={radars?.length} active={pathname === "/radar"} />
      <SideItem to="/import" icon="upload" label="Import leads" active={pathname === "/import"} />
      {list.length > 0 && <p className="side-head static find-label">{onNew ? "Recent" : "Running now"}</p>}
      {list.map((s) => (
        <Link key={s.id} to={`/searches/${s.id}`} className={`side-item${pathname === `/searches/${s.id}` ? " active" : ""}`} title={shortName(s)}>
          <Icon name={icon(s)} size={16} /><span className="label">{shortName(s)}</span>
          <span className="count">{s.status === "running" ? (s.found_count ? `${s.processed_count}/${s.found_count}` : "…") : s.status === "done" ? s.found_count : "—"}</span>
        </Link>
      ))}
    </>
  );
}
