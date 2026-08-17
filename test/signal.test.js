import test from "node:test";
import assert from "node:assert/strict";
import {
  SIGNAL,
  FLAGS,
  frameRequestsPlayback,
  encodePayloadBits,
  decodePayloadBits,
  frameToSymbols,
  symbolsToFrame,
  generateSignal,
  encodeWav
} from "../src/signal.js";
import {
  PREROLL_FRAMES,
  PREROLL_MS,
  generateProjectSignal
} from "../src/export-signal.js";
import {
  createProject,
  createCollectionMixtape,
  collectionImportPlan,
  frameAt,
  recomputeTimeline,
  createClip,
  splitClip,
  duplicateClip,
  timelineOrder,
  findProjectClip,
  moveClipToBuffer,
  moveClipToTimeline,
  overwriteLaneWithClip,
  activateProjectSide,
  cassetteSideCapacityMs,
  snapClipStart,
  activeClipsAt,
  addGainPoint,
  moveGainPoint,
  removeGainPoint,
  removeProjectClips,
  gainAtLocalMs
} from "../src/model.js";
import {
  CarrierGate,
  analyzeInputSignal,
  decodeGeneratedSignal,
  findFrameInSamples,
  smoothInputMetrics
} from "../src/decoder.js";
import { InputDecoderPipeline } from "../src/input-decoder-pipeline.js";

const fixture = {
  flags: FLAGS.playing,
  sequence: 42,
  timelineMs: 123_456,
  trackId: "186016",
  sourceMs: 12_345,
  gainDb: -4.25,
  gainTargetTimelineMs: 130_006,
  gainTargetDb: -8.5,
  nextTrackId: "5257138"
};

function projectWith(...clips) {
  const project = createProject("Test mixtape");
  project.clips.push(...clips);
  return recomputeTimeline(project);
}

test("protocol uses compact 4-FSK frames with a 6 kHz pilot", () => {
  assert.deepEqual(SIGNAL.tones, [1_200, 2_400, 3_600, 4_800]);
  assert.equal(SIGNAL.pilotTone, 6_000);
  assert.equal(SIGNAL.channels, 2);
  assert.equal(SIGNAL.payloadBytes, 38);
  assert.ok(SIGNAL.frameDurationMs < 250);
});

test("frame encoding round-trips transport and next gain target fields", () => {
  const decoded = symbolsToFrame(frameToSymbols(fixture));
  assert.equal(decoded.sequence, fixture.sequence);
  assert.equal(decoded.timelineMs, fixture.timelineMs);
  assert.equal(decoded.trackId, fixture.trackId);
  assert.equal(decoded.sourceMs, fixture.sourceMs);
  assert.equal(decoded.gainDb, fixture.gainDb);
  assert.equal(decoded.nextTrackId, fixture.nextTrackId);
  assert.equal(decoded.gainTargetTimelineMs, 130_006);
  assert.equal(decoded.gainTargetDb, fixture.gainTargetDb);
});

test("Hamming coding corrects a single bit error", () => {
  const source = Uint8Array.from([0x00, 0x5a, 0xff, 0x17]);
  const bits = encodePayloadBits(source);
  bits[18] ^= 1;
  const decoded = decodePayloadBits(bits);
  assert.deepEqual([...decoded.bytes], [...source]);
  assert.equal(decoded.correctedBits, 1);
});

test("generated stereo PCM duplicates every complete frame on L and R", () => {
  const clip = createClip({ neteaseId: "186016", title: "Track", durationMs: 2_000 });
  const project = projectWith(clip);
  const duration = SIGNAL.frameDurationMs * 3;
  const signal = generateSignal(duration, (time, sequence) => ({ ...frameAt(project, time), sequence }));
  const frames = decodeGeneratedSignal(signal);
  assert.equal(signal.left.length, SIGNAL.frameSymbols * SIGNAL.samplesPerSymbol * 3);
  assert.deepEqual(signal.left, signal.right);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].trackId, clip.neteaseId);
  assert.equal(frames[0].timelineMs, Math.round(SIGNAL.frameDurationMs));
});

test("WAV is stereo and its length exactly matches PCM duration", () => {
  const sampleFrames = SIGNAL.sampleRate * 2;
  const signal = { left: new Float32Array(sampleFrames), right: new Float32Array(sampleFrames) };
  const wav = encodeWav(signal);
  const view = new DataView(wav);
  assert.equal(wav.byteLength, 44 + sampleFrames * 4);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), SIGNAL.sampleRate);
  assert.equal(view.getUint32(40, true), sampleFrames * 4);
});

test("a 3:22 control signal has exactly 3:22 of stereo samples", () => {
  const signal = generateSignal(202_000, (timelineMs, sequence) => ({ ...fixture, timelineMs, sequence }));
  assert.equal(signal.left.length, SIGNAL.sampleRate * 202);
  assert.equal(signal.right.length, SIGNAL.sampleRate * 202);
});

test("project export adds at least five seconds of frame-aligned leader", () => {
  const first = createClip({ neteaseId: "186016", title: "First", durationMs: 2_000 });
  const second = createClip({ neteaseId: "5257138", title: "Next", durationMs: 2_000 });
  second.startMs = 2_000;
  const project = projectWith(first, second);
  const signal = generateProjectSignal(project);
  assert.equal(signal.left.length, Math.round((project.totalDurationMs + PREROLL_MS) * SIGNAL.sampleRate / 1000));
  assert.ok(PREROLL_MS >= 5_000);
  assert.ok(PREROLL_MS < 5_000 + SIGNAL.frameDurationMs);
  assert.equal(PREROLL_FRAMES, Math.ceil(5_000 / SIGNAL.frameDurationMs));

  const frames = decodeGeneratedSignal(signal);
  assert.ok(frames.slice(0, PREROLL_FRAMES - 1).every((frame) =>
    (frame.flags & FLAGS.preroll) && !(frame.flags & FLAGS.playing)
  ));
  assert.equal(frames[0].trackId, first.neteaseId);
  assert.equal(frames[0].nextTrackId, second.neteaseId);
  assert.equal(frameRequestsPlayback(frames[0]), false);
  const release = frames[PREROLL_FRAMES - 1];
  assert.ok(release.flags & FLAGS.playing);
  assert.equal(release.flags & FLAGS.preroll, 0);
  assert.equal(release.timelineMs, 0);
});

test("new projects start empty", () => {
  const project = createProject();
  assert.equal(project.clips.length, 0);
  assert.equal(project.totalDurationMs, 0);
  assert.equal(project.timelineVersion, 3);
  assert.equal(project.activeSide, "A");
  assert.equal(project.sides.B.clips.length, 0);
  assert.equal(cassetteSideCapacityMs(project), 30 * 60 * 1000);
});

test("cassette sides keep independent editable timelines", () => {
  const project = createProject("Two-sided tape");
  project.clips.push(createClip({ neteaseId: "11", title: "Side A song", durationMs: 5_000 }));
  recomputeTimeline(project);
  activateProjectSide(project, "B");
  assert.equal(project.clips.length, 0);
  project.clips.push(createClip({ neteaseId: "22", title: "Side B song", durationMs: 7_000 }));
  recomputeTimeline(project);
  activateProjectSide(project, "A");
  assert.deepEqual(project.clips.map((clip) => clip.neteaseId), ["11"]);
  assert.equal(project.totalDurationMs, 5_000);
  assert.equal(project.sides.B.totalDurationMs, 7_000);
});

test("buffer clips are shared across cassette sides and stay out of playback timing", () => {
  const project = createProject("Buffered tape");
  const clip = createClip({ neteaseId: "31", title: "Staged song", durationMs: 8_000 });
  project.clips.push(clip);
  recomputeTimeline(project);

  moveClipToBuffer(project, clip.id, 12_500, 84);
  assert.equal(project.clips.length, 0);
  assert.equal(project.totalDurationMs, 0);
  assert.deepEqual(findProjectClip(project, clip.id), { clip, zone: "buffer" });
  assert.equal(clip.bufferXMs, 12_500);
  assert.equal(clip.bufferY, 84);

  activateProjectSide(project, "B");
  assert.equal(project.bufferClips[0].id, clip.id);

  moveClipToTimeline(project, clip.id, 4_000);
  assert.equal(project.bufferClips.length, 0);
  assert.equal(project.clips[0].startMs, 4_000);
  assert.equal(project.totalDurationMs, 12_000);
  assert.equal(project.sides.A.clips.length, 0);
  assert.equal(project.sides.B.clips[0].id, clip.id);
});

test("buffer clips can be deleted without changing the active timeline selection", () => {
  const project = createProject("Delete buffered clip");
  const timelineClip = createClip({ neteaseId: "32", title: "Timeline", durationMs: 5_000 });
  const bufferClip = createClip({ neteaseId: "33", title: "Buffer", durationMs: 6_000 });
  project.clips.push(timelineClip);
  project.bufferClips.push(bufferClip);
  recomputeTimeline(project);

  assert.equal(removeProjectClips(project, [bufferClip.id]), 1);
  assert.deepEqual(project.clips.map((clip) => clip.id), [timelineClip.id]);
  assert.equal(project.bufferClips.length, 0);
  assert.equal(project.totalDurationMs, 5_000);
});

test("side-specific saved buffers migrate into one shared buffer without duplicates", () => {
  const project = createProject("Legacy buffered tape");
  const sideAClip = createClip({ neteaseId: "41", title: "From A", durationMs: 5_000 });
  const sideBClip = createClip({ neteaseId: "42", title: "From B", durationMs: 6_000 });
  sideAClip.bufferXMs = 1_000;
  sideBClip.bufferXMs = 2_000;
  project.sides.A.bufferClips = [sideAClip];
  project.sides.B.bufferClips = [sideBClip];
  project.bufferClips = [sideAClip];

  recomputeTimeline(project);

  assert.deepEqual(project.bufferClips.map((clip) => clip.id), [sideAClip.id, sideBClip.id]);
  assert.equal("bufferClips" in project.sides.A, false);
  assert.equal("bufferClips" in project.sides.B, false);
  activateProjectSide(project, "B");
  assert.deepEqual(project.bufferClips.map((clip) => clip.id), [sideAClip.id, sideBClip.id]);
});

test("collection import plans a side change between songs and reports overflow", () => {
  const tracks = [
    { title: "One", durationMs: 20_000 },
    { title: "Two", durationMs: 25_000 },
    { title: "Three", durationMs: 40_000 }
  ];
  const plan = collectionImportPlan(tracks, 1);
  assert.equal(plan.sideCapacityMs, 30_000);
  assert.equal(plan.cutTrackIndex, 1);
  assert.equal(plan.sideADurationMs, 20_000);
  assert.equal(plan.sideAGapMs, 10_000);
  assert.equal(plan.sideBDurationMs, 65_000);
  assert.equal(plan.overflowMs, 35_000);
});

test("collection import moves the crossing song intact to side B", () => {
  const imported = createCollectionMixtape("Imported album", [
    { neteaseId: "1", title: "One", durationMs: 20_000 },
    { neteaseId: "2", title: "Two", durationMs: 20_000 }
  ], 1);
  assert.equal(imported.sides.A.totalDurationMs, 20_000);
  assert.deepEqual(imported.sides.A.clips.map((clip) => [clip.neteaseId, clip.trimStartMs, clip.trimEndMs]), [
    ["1", 0, 20_000]
  ]);
  assert.equal(imported.sides.B.totalDurationMs, 20_000);
  assert.deepEqual(imported.sides.B.clips.map((clip) => [clip.neteaseId, clip.trimStartMs, clip.trimEndMs]), [
    ["2", 0, 20_000]
  ]);
  assert.equal(imported.activeSide, "A");
});

test("clip snapping uses only other clip edges", () => {
  assert.deepEqual(
    snapClipStart(1_420, 2_000),
    { startMs: 1_420, guideMs: null, distanceMs: null, snapped: false }
  );
  assert.deepEqual(
    snapClipStart(4_650, 2_000, [6_800], { thresholdMs: 500 }),
    { startMs: 4_800, guideMs: 6_800, distanceMs: 150, snapped: true }
  );
  assert.deepEqual(
    snapClipStart(4_650, 2_000, [9_000], { thresholdMs: 500 }),
    { startMs: 4_650, guideMs: null, distanceMs: null, snapped: false }
  );
});

test("gain key points encode the next target for smooth interpolation", () => {
  const clip = createClip({ neteaseId: "1", title: "Automation", durationMs: 10_000 });
  const middle = addGainPoint(clip, 5_000, -12);
  assert.equal(gainAtLocalMs(clip, 2_500), -6);
  moveGainPoint(clip, middle.id, 4_000, -8);
  assert.equal(gainAtLocalMs(clip, 2_000), -4);

  const project = projectWith(clip);
  const frame = frameAt(project, 2_000);
  assert.equal(frame.gainDb, -4);
  assert.equal(frame.gainTargetTimelineMs, 4_000);
  assert.equal(frame.gainTargetDb, -8);
  assert.equal(removeGainPoint(clip, middle.id), true);
  assert.equal(gainAtLocalMs(clip, 2_000), 0);
});

test("splitting preserves gain automation and total project duration", () => {
  const clip = createClip({ neteaseId: "1", title: "Automation", durationMs: 10_000 });
  addGainPoint(clip, 4_000, -12);
  const project = projectWith(clip);
  const originalDuration = project.totalDurationMs;
  const right = splitClip(project, clip.id, 5_000);
  assert.ok(right);
  assert.equal(gainAtLocalMs(clip, 4_000), -12);
  assert.equal(gainAtLocalMs(right, 0), gainAtLocalMs(clip, 5_000));
  assert.equal(right.gainPoints.at(-1).timeMs, 5_000);
  assert.equal(project.totalDurationMs, originalDuration);
});

test("legacy two-lane projects migrate into a non-overlapping single track", () => {
  const first = createClip({ neteaseId: "10", title: "A", durationMs: 10_000 });
  const second = createClip({ neteaseId: "20", title: "B", durationMs: 8_000 });
  const third = createClip({ neteaseId: "30", title: "C", durationMs: 6_000 });
  first.startMs = 0;
  second.startMs = 7_500;
  second.lane = 1;
  third.startMs = 14_000;
  const project = recomputeTimeline({ name: "Legacy", timelineVersion: 2, clips: [third, first, second] });
  const ordered = timelineOrder(project);
  assert.deepEqual(ordered.map((clip) => clip.neteaseId), ["10", "20", "30"]);
  assert.ok(ordered.every((clip) => clip.lane === 0));
  assert.deepEqual(ordered.map((clip) => clip.startMs), [0, 10_000, 18_000]);
  assert.deepEqual(ordered.map((clip) => clip.nextTrackId), ["20", "30", "0"]);
});

test("duplicating a clip always creates an independent item on the single track", () => {
  const original = createClip({ neteaseId: "77", title: "Copy", durationMs: 9_000 });
  original.gainDb = -3;
  const pasted = duplicateClip(original, 12_500, 1);
  assert.notEqual(pasted.id, original.id);
  assert.equal(pasted.startMs, 12_500);
  assert.equal(pasted.endMs, 21_500);
  assert.equal(pasted.lane, 0);
  pasted.gainDb = -9;
  assert.equal(original.gainDb, -3);
});

test("single-track overwrite removes only the covered portion of an older clip", () => {
  const previous = createClip({ neteaseId: "1", title: "Previous", durationMs: 10_000 });
  const incoming = createClip({ neteaseId: "2", title: "Incoming", durationMs: 2_000 });
  previous.startMs = 0;
  incoming.startMs = 4_000;
  const project = recomputeTimeline({ name: "Overwrite", timelineVersion: 3, clips: [previous, incoming] });
  const result = overwriteLaneWithClip(project, incoming.id);
  assert.deepEqual(result, { removed: 0, trimmed: 0, split: 1 });
  const pieces = timelineOrder(project);
  assert.deepEqual(
    pieces.map((clip) => [clip.neteaseId, clip.startMs, clip.endMs, clip.trimStartMs, clip.trimEndMs]),
    [
      ["1", 0, 4_000, 0, 4_000],
      ["2", 4_000, 6_000, 0, 2_000],
      ["1", 6_000, 10_000, 6_000, 10_000]
    ]
  );
  assert.deepEqual(activeClipsAt(project, 5_000).map((state) => state.clip.neteaseId), ["2"]);
});

test("batch-moved clips do not overwrite other protected clips in the selection", () => {
  const project = createProject("Batch move");
  const first = createClip({ neteaseId: "51", title: "First", durationMs: 5_000 });
  const second = createClip({ neteaseId: "52", title: "Second", durationMs: 5_000 });
  first.startMs = 2_000;
  second.startMs = 4_000;
  project.clips.push(first, second);
  recomputeTimeline(project);

  overwriteLaneWithClip(project, first.id, [first.id, second.id]);

  assert.deepEqual(project.clips.map((clip) => clip.id).sort(), [first.id, second.id].sort());
});

test("decoder locks from arbitrary offsets and either independent channel", () => {
  const clip = createClip({ neteaseId: "186016", title: "Track", durationMs: 2_000 });
  const project = projectWith(clip);
  const signal = generateSignal(SIGNAL.frameDurationMs, (time, sequence) => ({ ...frameAt(project, time), sequence }));
  const left = new Float32Array(signal.length + 317);
  const right = new Float32Array(signal.length + 317);
  left.set(signal.left, 317);
  right.set(signal.right, 317);

  const stereo = findFrameInSamples({ left, right });
  const mono = findFrameInSamples(left);
  const rightOnly = findFrameInSamples({ left: new Float32Array(left.length), right });
  assert.ok(stereo && mono && rightOnly);
  assert.equal(stereo.frame.trackId, clip.neteaseId);
  assert.equal(mono.frame.trackId, clip.neteaseId);
  assert.equal(rightOnly.frame.trackId, clip.neteaseId);
  assert.equal(rightOnly.inputChannel, "R");
  assert.ok(Math.abs(stereo.start - 317) <= SIGNAL.samplesPerSymbol);
});

test("decoder accepts a summed mono input", () => {
  const signal = generateSignal(SIGNAL.frameDurationMs, (_, sequence) => ({ ...fixture, sequence }));
  const summed = Float32Array.from(signal.left, (sample, index) => (sample + signal.right[index]) / 2);
  const result = findFrameInSamples(summed);
  assert.ok(result);
  assert.equal(result.frame.trackId, fixture.trackId);
});

test("input monitor distinguishes silence, ordinary audio, and the pilot", () => {
  const length = 4_096;
  const ordinaryAudio = Float32Array.from({ length }, (_, index) =>
    Math.sin(2 * Math.PI * 1_000 * index / SIGNAL.sampleRate) * 0.2
  );
  const pilotAudio = Float32Array.from({ length }, (_, index) =>
    Math.sin(2 * Math.PI * 4_800 * index / SIGNAL.sampleRate) * 0.5 +
    Math.sin(2 * Math.PI * 6_200 * index / SIGNAL.sampleRate) * 0.1
  );
  const silence = analyzeInputSignal(new Float32Array(length));
  const ordinary = analyzeInputSignal(ordinaryAudio);
  const pilot = analyzeInputSignal(pilotAudio);
  assert.equal(silence.inputDetected, false);
  assert.equal(silence.pilotDetected, false);
  assert.equal(ordinary.inputDetected, true);
  assert.equal(ordinary.pilotDetected, false);
  assert.equal(pilot.inputDetected, true);
  assert.equal(pilot.pilotDetected, true);
  assert.ok(Math.abs(pilot.pilotHz - 6_200) <= 25);
});

test("adjustable input noise gate rejects a pilot-like signal below its threshold", () => {
  const length = 4_096;
  const quietPilot = Float32Array.from({ length }, (_, index) =>
    Math.sin(2 * Math.PI * 4_800 * index / SIGNAL.sampleRate) * 0.01
    + Math.sin(2 * Math.PI * 6_000 * index / SIGNAL.sampleRate) * 0.002
  );
  const defaultGate = analyzeInputSignal(quietPilot);
  const strictGate = analyzeInputSignal(quietPilot, null, SIGNAL.sampleRate, -40);
  assert.equal(defaultGate.pilotDetected, true);
  assert.equal(strictGate.inputDetected, false);
  assert.equal(strictGate.pilotDetected, false);
  assert.equal(strictGate.noiseGateDb, -40);
});

test("input monitor accepts the generated pilot from either cassette channel", () => {
  const signal = generateSignal(SIGNAL.frameDurationMs, (_, sequence) => ({ ...fixture, sequence }));
  const silent = new Float32Array(signal.left.length);
  const left = analyzeInputSignal(signal.left, silent);
  const right = analyzeInputSignal(silent, signal.right);
  assert.equal(left.pilotDetected, true);
  assert.equal(left.pilotChannel, "L");
  assert.equal(right.pilotDetected, true);
  assert.equal(right.pilotChannel, "R");
});

test("input meter smoothing preserves detector state while damping level changes", () => {
  const previous = {
    levelDb: -40,
    pilotDb: -30,
    pilotDetected: true,
    channels: [{ label: "L", levelDb: -40, pilotDb: -30 }]
  };
  const current = {
    levelDb: -20,
    pilotDb: -10,
    pilotDetected: false,
    channels: [{ label: "L", levelDb: -20, pilotDb: -10 }]
  };
  const smoothed = smoothInputMetrics(previous, current, 0.25);
  assert.equal(smoothed.levelDb, -35);
  assert.equal(smoothed.pilotDb, -25);
  assert.equal(smoothed.channels[0].levelDb, -35);
  assert.equal(smoothed.pilotDetected, false);
});

test("background input pipeline acquires frames across 2048-sample capture blocks", () => {
  const signal = generateSignal(SIGNAL.frameDurationMs * 3, (_, sequence) => ({ ...fixture, sequence }));
  const pipeline = new InputDecoderPipeline();
  const decoded = [];
  let sawPilot = false;
  for (let offset = 0; offset < signal.length; offset += 2_048) {
    const result = pipeline.push(
      signal.left.subarray(offset, offset + 2_048),
      signal.right.subarray(offset, offset + 2_048)
    );
    sawPilot ||= result.metrics.pilotDetected;
    if (result.frame) decoded.push(result.frame);
  }
  assert.equal(sawPilot, true);
  assert.ok(decoded.length >= 1);
  assert.equal(decoded[0].trackId, fixture.trackId);
});

test("background decoder follows fractional cassette speed instead of rounding symbol timing", () => {
  const signal = generateSignal(SIGNAL.frameDurationMs * 5, (_, sequence) => ({ ...fixture, sequence }));
  const stretch = (samples, ratio) => {
    const output = new Float32Array(Math.floor(samples.length * ratio));
    for (let index = 0; index < output.length; index += 1) {
      const source = index / ratio;
      const before = Math.floor(source);
      const after = Math.min(samples.length - 1, before + 1);
      const fraction = source - before;
      output[index] = samples[before] + (samples[after] - samples[before]) * fraction;
    }
    return output;
  };
  const ratio = 1.004;
  const left = stretch(signal.left, ratio);
  const right = stretch(signal.right, ratio);
  const pipeline = new InputDecoderPipeline();
  const decoded = [];
  for (let offset = 0; offset < left.length; offset += 2_048) {
    const result = pipeline.push(
      left.subarray(offset, offset + 2_048),
      right.subarray(offset, offset + 2_048)
    );
    if (result.frame) decoded.push(result.frame);
  }
  assert.ok(decoded.length >= 2);
  assert.equal(decoded[0].trackId, fixture.trackId);
  assert.ok(Math.abs(decoded[0].speed - 1 / ratio) < 0.002);
});

test("carrier gate stops quickly and requires a fresh frame before restart", () => {
  const gate = new CarrierGate({ stopMs: 80, releaseMs: 500 });
  assert.equal(gate.update({ pilotDetected: true, validFrame: true, now: 1_000 }).live, true);
  assert.equal(gate.update({ pilotDetected: false, now: 1_050 }).live, true);
  assert.equal(gate.update({ pilotDetected: false, now: 1_081 }).live, false);
  assert.equal(gate.update({ pilotDetected: true, now: 1_200 }).live, false);
  assert.equal(gate.update({ pilotDetected: true, validFrame: true, now: 1_210 }).live, true);
});

test("carrier gate uses the capture timestamp instead of extending a stale audio block", () => {
  const gate = new CarrierGate({ stopMs: 90 });
  assert.equal(gate.update({ pilotDetected: true, validFrame: true, detectedAt: 1_000, now: 1_040 }).live, true);
  assert.equal(gate.update({ pilotDetected: true, detectedAt: 1_000, now: 1_091 }).live, false);
});

test("default carrier hysteresis tolerates several capture-block gaps", () => {
  const gate = new CarrierGate();
  assert.equal(gate.update({ pilotDetected: true, validFrame: true, now: 1_000 }).live, true);
  assert.equal(gate.update({ pilotDetected: false, now: 1_279 }).live, true);
  assert.equal(gate.update({ pilotDetected: false, now: 1_280 }).live, false);
});
