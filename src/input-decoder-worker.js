import { InputDecoderPipeline } from "./input-decoder-pipeline.js";

const pipeline = new InputDecoderPipeline();

self.addEventListener("message", (event) => {
  if (event.data?.type === "reset") {
    pipeline.reset();
    return;
  }
  if (!event.data?.left) return;

  const left = new Float32Array(event.data.left);
  const right = event.data.right ? new Float32Array(event.data.right) : null;
  const frame = pipeline.decode(left, right);
  if (frame) self.postMessage({ type: "frame", frame });
});
