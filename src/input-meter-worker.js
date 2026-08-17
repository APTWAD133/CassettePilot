import { SIGNAL } from "./signal.js";
import { analyzeInputSignal } from "./decoder.js";

self.addEventListener("message", (event) => {
  if (!event.data?.left) return;
  const left = new Float32Array(event.data.left);
  const right = event.data.right ? new Float32Array(event.data.right) : null;
  const metrics = analyzeInputSignal(
    left,
    right,
    event.data.sampleRate || SIGNAL.sampleRate,
    event.data.noiseGateDb
  );
  self.postMessage({ type: "metrics", metrics });
});
