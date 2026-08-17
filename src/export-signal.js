import { SIGNAL, FLAGS, generateSignal } from "./signal.js";
import { frameAt } from "./model.js";

export const PREROLL_FRAMES = Math.ceil(5_000 / SIGNAL.frameDurationMs);
export const PREROLL_MS = PREROLL_FRAMES * SIGNAL.frameDurationMs;

export function projectFrameAtSignalTime(project, signalTimeMs) {
  const first = frameAt(project, 0);
  if (signalTimeMs + 0.001 < PREROLL_MS) {
    return {
      ...first,
      flags: (first.flags & ~(FLAGS.playing | FLAGS.end)) | FLAGS.preroll,
      timelineMs: 0,
      sourceMs: first.sourceMs,
      gainDb: first.gainDb
    };
  }
  return frameAt(project, Math.max(0, signalTimeMs - PREROLL_MS));
}

export function generateProjectSignal(project) {
  return generateSignal(
    project.totalDurationMs + PREROLL_MS,
    (signalTimeMs, sequence) => ({
      ...projectFrameAtSignalTime(project, signalTimeMs),
      sequence
    })
  );
}
