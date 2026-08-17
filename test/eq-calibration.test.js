import test from "node:test";
import assert from "node:assert/strict";
import {
  EQ_CALIBRATION,
  analyzeRecordedEqCalibration,
  deriveCassetteDiagnostic,
  generateEqCalibrationSignal,
  normalizeDiagnosticStore
} from "../src/eq-calibration.js";

test("calibration signal has identified stereo blocks", () => {
  const signal = generateEqCalibrationSignal();
  assert.equal(signal.left.length, signal.right.length);
  assert.equal(signal.manifest.durationMs, 28_000);
  const leftSweep = Math.round(signal.manifest.offsetsMs.leftSweep * EQ_CALIBRATION.sampleRate / 1_000);
  const rightSweep = Math.round(signal.manifest.offsetsMs.rightSweep * EQ_CALIBRATION.sampleRate / 1_000);
  assert.notEqual(signal.left[leftSweep + 10_000], 0);
  assert.equal(signal.right[leftSweep + 10_000], 0);
  assert.equal(signal.left[rightSweep + 10_000], 0);
  assert.notEqual(signal.right[rightSweep + 10_000], 0);
});

test("diagnostic derives balance, bandwidth, SNR, crosstalk, THD, and speed", () => {
  const leftDb = [-48, -42, -36, -30, -24, -20, -20, -20, -20, -20, -19, -17, -14, -10];
  const rightDb = leftDb.map((value) => value - 1);
  const report = deriveCassetteDiagnostic({
    frequencies: [...EQ_CALIBRATION.frequencies],
    leftDb,
    rightDb,
    leftSweepLeakDb: leftDb.map((value) => value - 32),
    rightSweepLeakDb: rightDb.map((value) => value - 30),
    leftNoiseDb: -52,
    rightNoiseDb: -70,
    speedRatio: 1.015,
    thdPercent: { left: 2.4, right: 2.8 }
  }, { id: "deck-a", name: "Deck A" });
  assert.equal(report.id, "deck-a");
  assert.equal(report.channelBalanceDb, 1);
  assert.equal(report.crosstalkDb.leftToRight, 32);
  assert.equal(report.crosstalkDb.rightToLeft, 30);
  assert.equal(report.thdPercent.left, 2.4);
  assert.ok(report.channels.right.snrDb > report.channels.left.snrDb);
  assert.ok(Math.abs(report.speedErrorPercent - 1.5) < 0.001);
  assert.ok(report.channels.left.bandwidth6Db.highHz >= 4_000);
});

test("diagnostic store discards malformed reports and preserves the active report", () => {
  const valid = deriveCassetteDiagnostic({
    frequencies: [...EQ_CALIBRATION.frequencies],
    leftDb: EQ_CALIBRATION.frequencies.map(() => -20),
    rightDb: EQ_CALIBRATION.frequencies.map(() => -20),
    leftNoiseDb: -80,
    rightNoiseDb: -80
  }, { id: "valid", name: "Valid" });
  const normalized = normalizeDiagnosticStore({ reports: [{ nope: true }, valid], activeId: "valid" });
  assert.deepEqual(normalized.reports.map(({ id }) => id), ["valid"]);
  assert.equal(normalized.activeId, "valid");
});

function stretchAndDegrade(source, ratio, channel = 0) {
  const output = new Float32Array(Math.floor(source.length * ratio));
  for (let index = 0; index < output.length; index += 1) {
    const position = index / ratio;
    const before = Math.min(source.length - 1, Math.floor(position));
    const after = Math.min(source.length - 1, before + 1);
    const fraction = position - before;
    const sample = source[before] + (source[after] - source[before]) * fraction;
    const noise = Math.sin(2 * Math.PI * (173 + channel * 37) * index / EQ_CALIBRATION.sampleRate) * 0.0015;
    output[index] = sample * 0.82 + noise;
  }
  return output;
}

test("uploaded stereo calibration is identified and measured offline", async () => {
  const signal = generateEqCalibrationSignal();
  const measurement = await analyzeRecordedEqCalibration({
    left: signal.left,
    right: signal.right,
    sampleRate: EQ_CALIBRATION.sampleRate
  });
  assert.equal(measurement.frequencies.length, EQ_CALIBRATION.frequencies.length);
  assert.ok(Math.abs(measurement.speedRatio - 1) < 0.01);
  assert.ok(measurement.markersSeconds.start > 1.8 && measurement.markersSeconds.start < 2.2);
  assert.ok(measurement.thdPercent.left < 0.1);
  const report = deriveCassetteDiagnostic(measurement);
  assert.ok(report.crosstalkDb.leftToRight > 40);
  assert.ok(report.channels.left.snrDb > 40);
});

test("uploaded calibration tolerates tape-speed drift, attenuation, and noise", async () => {
  const signal = generateEqCalibrationSignal();
  const timeScale = 1.018;
  const measurement = await analyzeRecordedEqCalibration({
    left: stretchAndDegrade(signal.left, timeScale, 0),
    right: stretchAndDegrade(signal.right, timeScale, 1),
    sampleRate: EQ_CALIBRATION.sampleRate
  });
  assert.ok(Math.abs(measurement.speedRatio - 1 / timeScale) < 0.012);
});

test("marker detection tolerates strong odd-harmonic distortion and channel imbalance", async () => {
  const signal = generateEqCalibrationSignal();
  const distort = (source, gain) => Float32Array.from(source, (sample) =>
    Math.tanh(sample * 7) / Math.tanh(7) * gain
  );
  const measurement = await analyzeRecordedEqCalibration({
    left: distort(signal.left, 0.7),
    right: distort(signal.right, 0.08),
    sampleRate: EQ_CALIBRATION.sampleRate
  });
  assert.equal(measurement.markers.length, 3);
  assert.ok(measurement.markers.every((marker) => !marker.inferred));
  assert.ok(measurement.markers[2].snrDb > 7);
  assert.ok(measurement.thdPercent.left > 5);
});

test("a missing final marker is inferred from two verified markers", async () => {
  const signal = generateEqCalibrationSignal();
  const left = new Float32Array(signal.left);
  const right = new Float32Array(signal.right);
  const endStart = Math.round(signal.manifest.offsetsMs.endMarker * EQ_CALIBRATION.sampleRate / 1_000);
  const endLength = Math.round(EQ_CALIBRATION.markerMs * EQ_CALIBRATION.sampleRate / 1_000);
  left.fill(0, endStart, endStart + endLength);
  right.fill(0, endStart, endStart + endLength);
  const measurement = await analyzeRecordedEqCalibration({ left, right, sampleRate: EQ_CALIBRATION.sampleRate });
  assert.equal(measurement.markers[2].inferred, true);
  assert.ok(Math.abs(measurement.markersSeconds.end - signal.manifest.offsetsMs.endMarker / 1_000) < 0.2);
});

test("uploaded calibration reports an incomplete recording", async () => {
  await assert.rejects(() => analyzeRecordedEqCalibration({
    left: new Float32Array(EQ_CALIBRATION.sampleRate * 10),
    right: new Float32Array(EQ_CALIBRATION.sampleRate * 10),
    sampleRate: EQ_CALIBRATION.sampleRate
  }), /too short/i);
});
