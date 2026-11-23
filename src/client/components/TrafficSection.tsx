import type { ReactNode } from "react";
import type { TrafficView } from "../trafficView";
import { splitBeside } from "../careReportPageView";
import { PubNote, Tile } from "./PublicPage";
import type { IconName } from "./Icon";

function Stats({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <div className="pbx-stats">
      {rows.map((row) => {
        const { figure, before } = splitBeside(row.value);
        return <div key={row.label} className="pbx-stat"><span>{row.label}</span><b>{figure}</b>{before && <small>{before}</small>}</div>;
      })}
    </div>
  );
}

function Ranked({ title, rows }: { title: string; rows: { text: string; value: string }[] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="pbx-label">{title}</p>
      <ol className="pbx-rows inset">
        {rows.map((r, i) => <li key={i}><span className="pbx-rank">{i + 1}</span><span className="pbx-row-text"><b>{r.text}</b></span><span className="pbx-row-num">{r.value}</span></li>)}
      </ol>
    </div>
  );
}

function Block({ icon, tone, title, sub, children }: { icon: IconName; tone: "info" | "positive" | "signal"; title: string; sub: string; children: ReactNode }) {
  return (
    <article className="pbx-card flush">
      <div className="pbx-card-head"><Tile icon={icon} tone={tone} /><div><h2>{title}</h2><small>{sub}</small></div></div>
      <div className="pbx-body">{children}</div>
    </article>
  );
}

/** The "Search and visits" section of a client's report page (Care's, Local SEO's and the strategy memo). Every query and page path is entered by a stranger, so each is a React text node, which escapes it. */
export default function TrafficSection({ view, intro }: { view: TrafficView; intro?: string | null }) {
  return (
    <section className="pbx-col" aria-labelledby="mr-traffic-h">
      <div className="pbx-section-h"><h2 id="mr-traffic-h">Search and visits</h2>{intro && <span>{intro}</span>}</div>
      {view.search && (
        <Block icon="search" tone="info" title="In Google's search results" sub="How often your site was shown, and clicked">
          {view.search.empty && <p className="pbx-sub">{view.search.empty}</p>}
          {view.search.rows.length > 0 && <Stats rows={view.search.rows} />}
          <Ranked title="What people searched for" rows={view.search.queries} />
          <Ranked title="Pages people came to from search" rows={view.search.pages} />
        </Block>
      )}
      {view.visits && (
        <Block icon="users" tone="positive" title="Visits to your site" sub="Everyone who came, from anywhere">
          <Stats rows={view.visits.rows} />
        </Block>
      )}
      {view.profile && (
        <Block icon="pin" tone="signal" title="Google Business Profile" sub="What people did on your Google listing">
          <Stats rows={view.profile.rows} />
        </Block>
      )}
      <PubNote>{view.note}</PubNote>
    </section>
  );
}
