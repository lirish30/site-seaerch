import { scriptEngine } from "./python.ts";
import type { RunPython, VoiceEngine } from "./engine.ts";

/** `qwen3-tts`, run by `helper/scripts/qwen3.py` in its own venv. */
export const qwen3Engine = (py: string, run?: RunPython): VoiceEngine => scriptEngine({ id: "qwen3-tts", script: "qwen3.py", py, run });
