import { useLocation } from "react-router-dom";
import { SideItem, SideLabel, SideTitle } from "./parts";

const is = (pathname: string, search: string, path: string, query?: Record<string, string | null>) => {
  if (pathname !== path) return false;
  const p = new URLSearchParams(search);
  return Object.entries(query ?? {}).every(([k, v]) => p.get(k) === v);
};

/** Sales: the pipeline board and the campaigns that feed it. */
export function SalesSidebar() {
  const { pathname, search } = useLocation();
  return (
    <>
      <SideTitle title="Sales" />
      <SideItem to="/pipeline" icon="kanban" label="Pipeline" active={is(pathname, search, "/pipeline", { stage: null })} />
      <SideItem to="/pipeline?stage=proposal_sent" icon="file-text" label="Proposals out" active={is(pathname, search, "/pipeline", { stage: "proposal_sent" })} />
      <SideItem to="/pipeline?stage=booked" icon="calendar" label="Booked calls" active={is(pathname, search, "/pipeline", { stage: "booked" })} />
      <SideItem to="/pipeline?stage=closed" icon="check" label="Won and lost" active={is(pathname, search, "/pipeline", { stage: "closed" })} />
      <SideLabel>Campaigns</SideLabel>
      <SideItem to="/campaigns" icon="target" label="All campaigns" active={pathname === "/campaigns"} />
      <div className="side-spacer" />
    </>
  );
}

/** Clients: everyone you look after, the Care and Local SEO boards, and the grades. */
export function ClientsSidebar() {
  const { pathname, search } = useLocation();
  return (
    <>
      <SideTitle title="Clients" />
      <SideItem to="/clients" icon="building" label="All clients" active={is(pathname, search, "/clients", { grade: null, view: null })} />
      <SideItem to="/care" icon="shield" label="Care" active={pathname === "/care"} />
      <SideItem to="/care/reports" icon="file-text" label="Care reports" active={pathname === "/care/reports"} />
      <SideItem to="/care/updates" icon="refresh" label="Care updates" active={pathname === "/care/updates"} />
      <SideItem to="/seo" icon="pin" label="Local SEO" active={pathname === "/seo"} />
      <SideLabel>Grade</SideLabel>
      <SideItem to="/clients?grade=A" icon="star" label="A clients" active={is(pathname, search, "/clients", { grade: "A" })} />
      <SideItem to="/clients?grade=B" icon="star" label="B clients" active={is(pathname, search, "/clients", { grade: "B" })} />
      <SideItem to="/clients?grade=C" icon="star" label="C clients" active={is(pathname, search, "/clients", { grade: "C" })} />
      <SideLabel>Needs attention</SideLabel>
      <SideItem to="/clients?view=access" icon="key" label="Access missing" active={is(pathname, search, "/clients", { view: "access" })} />
      <SideItem to="/clients?view=owing" icon="alert" label="Owes money" active={is(pathname, search, "/clients", { view: "owing" })} />
      <div className="side-spacer" />
    </>
  );
}

/** Money: the dashboard, then invoices, subscriptions and holds. */
export function MoneySidebar() {
  const { pathname, search } = useLocation();
  return (
    <>
      <SideTitle title="Money" />
      <SideItem to="/money" icon="trending" label="Dashboard" active={pathname === "/money"} />
      <SideItem to="/billing" icon="file-text" label="Invoices" active={is(pathname, search, "/billing", { tab: null })} />
      <SideItem to="/billing?tab=subscriptions" icon="refresh" label="Subscriptions" active={is(pathname, search, "/billing", { tab: "subscriptions" })} />
      <SideItem to="/billing?tab=holds" icon="ban" label="Holds" active={is(pathname, search, "/billing", { tab: "holds" })} />
      <div className="side-spacer" />
      <SideItem to="/settings/billing" icon="sliders" label="Billing settings" active={false} />
      <div className="side-gap" aria-hidden="true" />
    </>
  );
}
