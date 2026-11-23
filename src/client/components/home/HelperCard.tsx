import { Link } from "react-router-dom";
import Icon from "../Icon";
import { helperLine, type HelperStatus } from "../../helperView";
import type { Part } from "./useHome";

/** Whether your Mac helper (the app that makes the voice and the video) is running, and how much is waiting for it. One quiet row: it only reports. */
export default function HelperCard({ helper, onRetry }: { helper: Part<HelperStatus>; onRetry: () => void }) {
  const h = helper.data;
  return (
    <section className={`hox-helper${h ? (h.online ? " on" : " off") : ""}`} id="helper" aria-label="Mac helper">
      <span className="ds-tile" aria-hidden="true"><Icon name="zap" size={16} /></span>
      <div className="hox-helper-text">
        <b>Mac helper</b>
        {!h && helper.error ? (
          <span role="alert">{helper.error} <button type="button" className="hox-link" onClick={onRetry}>Try again</button></span>
        ) : !h ? (
          <i className="hox-skel" style={{ width: 120, height: 12 }} />
        ) : (
          <span role="status"><i className="hox-dot" aria-hidden="true" />{helperLine(h)}{!h.online && " It makes the voice and video for audits."}</span>
        )}
      </div>
      <Link to="/settings/helper" className="btn sm">Set up</Link>
    </section>
  );
}
