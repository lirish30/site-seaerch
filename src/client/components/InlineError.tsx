import { Link } from "react-router-dom";

/** An error shown right beside the button that caused it, with a Settings link when Settings is the fix. */
export default function InlineError({ message }: { message: string }) {
  if (!message) return null;
  return <p className="error" role="alert">{message}{/Settings/.test(message) && <> · <Link to="/settings">Open Settings</Link></>}</p>;
}
