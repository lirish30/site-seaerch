import { Link } from "react-router-dom";
import Icon from "../Icon";
import { helperLine, type HelperStatus } from "../../helperView";
import type { Part } from "./useHome";

/** Whether your Mac helper (the app that makes the voice and the video) is running, and how much is waiting for it. It only reports. */
export default function HelperCard({ helper, onRetry }: { helper: Part<HelperStatus>; onRetry: () => void }) {
  const h = helper.data;
  return (
    <section className="hm-card hm-helper" id="helper" aria-labelledby="hm-helper-h">
      <header className="hm-card-head">
        <Icon name="zap" size={16} />
        <h2 id="hm-helper-h">Mac helper</h2>
        <Link to="/settings/helper" className="hm-head-note small">Set up</Link>
      </header>
      {!h && helper.error ? (
        <div className="hm-state sm" role="alert"><p>{helper.error}</p><button type="button" className="btn sm" onClick={onRetry}>Try again</button></div>
      ) : !h ? (
        <div className="hm-card-body"><i className="hm-skel" style={{ width: "50%", height: 18 }} /></div>
      ) : (
        <div className="hm-state sm" role="status"><p><i className={`hm-helper-dot${h.online ? " on" : ""}`} aria-hidden="true" />{helperLine(h)}</p></div>
      )}
    </section>
  );
}
