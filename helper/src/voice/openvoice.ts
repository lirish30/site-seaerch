import { scriptEngine } from "./python.ts";
import type { RunPython, VoiceEngine } from "./engine.ts";

/** `openvoice-v2`, run by `helper/scripts/openvoice.py` in its own venv. */
export const openvoiceEngine = (py: string, run?: RunPython): VoiceEngine => scriptEngine({ id: "openvoice-v2", script: "openvoice.py", py, run });
