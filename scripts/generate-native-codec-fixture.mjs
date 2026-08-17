import { writeFile } from "node:fs/promises";
import { encodeWav, generateSignal, SIGNAL } from "../src/signal.js";

const output = process.argv[2];
if (!output) throw new Error("Pass an output WAV path.");

const segment = () => generateSignal(SIGNAL.frameDurationMs * 4, (timelineMs, sequence) => ({
    version: 2,
    flags: 1,
    sequence,
    timelineMs,
    trackId: "32194496",
    sourceMs: 12_000 + timelineMs,
    gainDb: -4.5,
    gainTargetTimelineMs: timelineMs + 1_000,
    gainTargetDb: -2,
    nextTrackId: "18795454"
  }));

let samples = segment();
if (process.argv.includes("--with-gap")) {
  const resumed = segment();
  const gapFrames = SIGNAL.sampleRate;
  const left = new Float32Array(samples.left.length + gapFrames + resumed.left.length);
  const right = new Float32Array(left.length);
  left.set(samples.left);
  right.set(samples.right);
  left.set(resumed.left, samples.left.length + gapFrames);
  right.set(resumed.right, samples.right.length + gapFrames);
  samples = { left, right };
}

await writeFile(output, Buffer.from(encodeWav(samples)));
