import { access, constants, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runProcess } from "../exec.ts";
import type { EngineId } from "../config.ts";
import type { RunPython, VoiceEngine } from "./engine.ts";

/** One line of speech may take a while on a laptop (a cold model load, then the synthesis). */
export const LINE_TIMEOUT_MS = 5 * 60_000;

/** Where the three engine scripts live. */
export const SCRIPTS_DIR = fileURLToPath(new URL("../../scripts/", import.meta.url));

/** Runs `script` with the Python of one engine's venv. Rejects with the script's own last words on failure and after five minutes. */
export const runPython: RunPython = async (py, script, args) => {
  await runProcess(py, [script, ...args], { timeoutMs: LINE_TIMEOUT_MS });
};

/**
 * An engine that is one of the Python scripts. The script is called as `script --text-file T --ref R --out O` and writes a wav to O; `--check`
 * only imports the library, which is how `available()` knows the venv is complete. The text goes through a file, so no quote, newline or leading
 * dash in a line can change how the arguments are read.
 */
export function scriptEngine(o: { id: EngineId; script: string; py: string; run?: RunPython }): VoiceEngine {
  const run = o.run ?? runPython;
  const script = join(SCRIPTS_DIR, o.script);
  let ready = false;
  return {
    id: o.id,
    async available() {
      if (ready) return { ok: true };
      try { await access(o.py, constants.X_OK); }
      catch { return { ok: false, why: `there is no Python at ${o.py}; create the ${o.id} venv as the README says, or set python.${o.id} in the config` }; }
      try { await run(o.py, script, ["--check"]); }
      catch (e) { return { ok: false, why: e instanceof Error ? e.message : String(e) }; }
      ready = true;
      return { ok: true };
    },
    async synth({ text, refAudioPath, outPath }) {
      const textFile = `${outPath}.txt`;
      await writeFile(textFile, text, "utf8");
      await run(o.py, script, ["--text-file", textFile, "--ref", refAudioPath, "--out", outPath]);
      const made = await stat(outPath).catch(() => null);
      if (!made || made.size === 0) throw new Error(`${o.id} finished but wrote no audio`);
    },
  };
}
