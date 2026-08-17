import { SIGNAL, encodeWav } from "./signal.js";
import { generateProjectSignal } from "./export-signal.js";

self.addEventListener("message", (event) => {
  try {
    const samples = generateProjectSignal(event.data.project);
    const wav = encodeWav(samples);
    const durationMs = samples.left.length / SIGNAL.sampleRate * 1_000;
    self.postMessage({ wav, durationMs }, [wav]);
  } catch (error) {
    self.postMessage({ error: error?.message || "Could not encode the control signal" });
  }
});
