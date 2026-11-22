import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { api } from "../api";
import { Empty } from "../components/ds";
import type { TaskDetail } from "../workData";

/** /tasks/:id finds the project the task is in and opens it on that task (the link an approval card uses for a step Claude did). */
export default function TaskRedirect() {
  const { id = "" } = useParams();
  const [to, setTo] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api.get<TaskDetail>(`/tasks/${encodeURIComponent(id)}`).then((r) => { if (live) setTo(`/projects/${encodeURIComponent(r.task.projectId)}?task=${encodeURIComponent(r.task.id)}`); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [id]);
  if (to) return <Navigate to={to} replace />;
  if (failed) {
    return (
      <div className="ds-page wkx"><div className="ds-body"><div className="ds-card">
        <Empty icon="alert" title="Couldn’t find that task" action={<Link to="/projects" className="btn">Back to projects</Link>}>It may have been removed from its project, or the link is out of date.</Empty>
      </div></div></div>
    );
  }
  return <div className="ds-page wkx"><div className="ds-body"><p className="muted">Opening the step…</p></div></div>;
}
