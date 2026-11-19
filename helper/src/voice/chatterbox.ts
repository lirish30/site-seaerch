import { scriptEngine } from "./python.ts";
import type { RunPython, VoiceEngine } from "./engine.ts";

/** `chatterbox`, run by `helper/scripts/chatterbox.py` in its own venv. */
export const chatterboxEngine = (py: string, run?: RunPython): VoiceEngine => scriptEngine({ id: "chatterbox", script: "chatterbox.py", py, run });
