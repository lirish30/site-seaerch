import { saveText, type SaveState } from "./useSaver";

/** Where a box's text stands ("Not saved yet", "Saving...", "Saved", or what went wrong). Read out politely; a passing error offers a retry. */
export default function SaveNote({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  const text = saveText(state);
  const isError = state.phase === "error";
  return (
    <p className={`pbx-save${isError ? " error" : ""}`} role={isError ? "alert" : "status"} aria-live={isError ? "assertive" : "polite"}>
      {text}
      {isError && state.retryable && <> <button type="button" className="pbx-linkbtn" onClick={onRetry}>Try again</button></>}
    </p>
  );
}
