import type { TrafficView } from "../trafficView";

/** The "Search and visits" section of a client's monthly report page (Care's and Local SEO's). Every query and page path is entered by a stranger, so each is a React text node, which escapes it. */
export default function TrafficSection({ view }: { view: TrafficView }) {
  return (
    <section className="mr-section" aria-labelledby="mr-traffic-h">
      <h2 id="mr-traffic-h" className="mr-h">Search and visits</h2>
      {view.search && (
        <article className="rp-card mr-site">
          <h3>In Google's search results</h3>
          {view.search.empty && <p className="mr-note">{view.search.empty}</p>}
          {view.search.rows.length > 0 && (
            <dl className="mr-rows">
              {view.search.rows.map((row) => <div key={row.label} className="mr-row"><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
            </dl>
          )}
          {view.search.queries.length > 0 && (
            <>
              <p className="mr-note">What people searched for</p>
              <ul className="mr-renewals">
                {view.search.queries.map((q, i) => <li key={`q-${i}`}><span className="mr-renewal-title">{q.text}</span><span className="mr-renewal-date">{q.value}</span></li>)}
              </ul>
            </>
          )}
          {view.search.pages.length > 0 && (
            <>
              <p className="mr-note">Pages people came to from search</p>
              <ul className="mr-renewals">
                {view.search.pages.map((p, i) => <li key={`p-${i}`}><span className="mr-renewal-title">{p.text}</span><span className="mr-renewal-date">{p.value}</span></li>)}
              </ul>
            </>
          )}
        </article>
      )}
      {view.visits && (
        <article className="rp-card mr-site">
          <h3>Visits to your site</h3>
          <dl className="mr-rows">
            {view.visits.rows.map((row) => <div key={row.label} className="mr-row"><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
          </dl>
        </article>
      )}
      {view.profile && (
        <article className="rp-card mr-site">
          <h3>Google Business Profile</h3>
          <dl className="mr-rows">
            {view.profile.rows.map((row) => <div key={row.label} className="mr-row"><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
          </dl>
        </article>
      )}
      <p className="mr-note">{view.note}</p>
    </section>
  );
}
