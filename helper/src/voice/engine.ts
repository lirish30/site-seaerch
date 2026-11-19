import { ENGINE_IDS, type Config, type EngineId } from "../config.ts";
import { chatterboxEngine } from "./chatterbox.ts";
import { openvoiceEngine } from "./openvoice.ts";
import { qwen3Engine } from "./qwen3.ts";

export { ENGINE_IDS, type EngineId };

/** One way of speaking a line in the owner's cloned voice. */
export interface VoiceEngine {
  id: EngineId;
  /** Whether this engine can run on this Mac now; `why` says what is missing when it cannot. */
  available(): Promise<{ ok: boolean; why?: string }>;
  /** Writes the line, spoken in the voice of `refAudioPath`, to `outPath` (any audio format ffmpeg reads). Rejects if it could not. */
  synth(o: { text: string; refAudioPath: string; outPath: string }): Promise<void>;
}

export type RunPython = (py: string, script: string, args: string[]) => Promise<void>;

/** The three engines, each running its script in the venv the config names for it. */
export function createEngines(cfg: Pick<Config, "python">, run?: RunPython): Record<EngineId, VoiceEngine> {
  return {
    "qwen3-tts": qwen3Engine(cfg.python["qwen3-tts"], run),
    chatterbox: chatterboxEngine(cfg.python["chatterbox"], run),
    "openvoice-v2": openvoiceEngine(cfg.python["openvoice-v2"], run),
  };
}
