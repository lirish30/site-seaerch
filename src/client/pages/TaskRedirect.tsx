import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { api } from "../api";
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
  if (failed) return <div className="wk"><p className="error wk-body" role="alert">Couldn’t find that task. <Link to="/projects">Back to projects</Link></p></div>;
  return <div className="wk"><p className="muted wk-body">Opening the step…</p></div>;
}
