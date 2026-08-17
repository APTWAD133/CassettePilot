export const EQ_CALIBRATION = Object.freeze({
  version: 1,
  sampleRate: 48_000,
  silenceMs: 2_000,
  markerMs: 1_000,
  guardMs: 500,
  sweepMs: 10_000,
  sweepStartHz: 40,
  sweepEndHz: 16_000,
  amplitude: 0.25,
  startMarkerHz: 1_000,
  separatorMarkerHz: 2_000,
  endMarkerHz: 3_000,
  frequencies: Object.freeze([40, 63, 100, 160, 250, 400, 630, 1_000, 1_600, 2_500, 4_000, 6_300, 10_000, 16_000])
});

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function samplesFor(ms) {
  return Math.round(EQ_CALIBRATION.sampleRate * ms / 1_000);
}

function writeTone(left, right, offset, duration, frequency, amplitude = EQ_CALIBRATION.amplitude) {
  const fadeSamples = Math.min(samplesFor(12), Math.floor(duration / 4));
  for (let index = 0; index < duration; index += 1) {
    const edge = Math.min(1, index / Math.max(1, fadeSamples), (duration - index - 1) / Math.max(1, fadeSamples));
    const sample = Math.sin(2 * Math.PI * frequency * index / EQ_CALIBRATION.sampleRate) * amplitude * edge;
    left[offset + index] = sample;
    right[offset + index] = sample;
  }
}

function writeSweep(channel, offset, duration) {
  const ratio = EQ_CALIBRATION.sweepEndHz / EQ_CALIBRATION.sweepStartHz;
  const seconds = duration / EQ_CALIBRATION.sampleRate;
  const angularScale = 2 * Math.PI * EQ_CALIBRATION.sweepStartHz * seconds / Math.log(ratio);
  const fadeSamples = samplesFor(20);
  for (let index = 0; index < duration; index += 1) {
    const progress = index / duration;
    const phase = angularScale * (Math.pow(ratio, progress) - 1);
    const edge = Math.min(1, index / fadeSamples, (duration - index - 1) / fadeSamples);
    channel[offset + index] = Math.sin(phase) * EQ_CALIBRATION.amplitude * Math.max(0, edge);
  }
}

export function generateEqCalibrationSignal() {
  const silence = samplesFor(EQ_CALIBRATION.silenceMs);
  const marker = samplesFor(EQ_CALIBRATION.markerMs);
  const guard = samplesFor(EQ_CALIBRATION.guardMs);
  const sweep = samplesFor(EQ_CALIBRATION.sweepMs);
  const startMarker = silence;
  const leftSweep = startMarker + marker + guard;
  const separatorMarker = leftSweep + sweep;
  const rightSweep = separatorMarker + marker + guard;
  const endMarker = rightSweep + sweep;
  const length = endMarker + marker + silence;
  const left = new Float32Array(length);
  const right = new Float32Array(length);

  writeTone(left, right, startMarker, marker, EQ_CALIBRATION.startMarkerHz);
  writeSweep(left, leftSweep, sweep);
  writeTone(left, right, separatorMarker, marker, EQ_CALIBRATION.separatorMarkerHz);
  writeSweep(right, rightSweep, sweep);
  writeTone(left, right, endMarker, marker, EQ_CALIBRATION.endMarkerHz);

  return {
    left,
    right,
    manifest: {
      ...EQ_CALIBRATION,
      durationMs: Math.round(length * 1_000 / EQ_CALIBRATION.sampleRate),
      offsetsMs: {
        startMarker: EQ_CALIBRATION.silenceMs,
        leftSweep: EQ_CALIBRATION.silenceMs + EQ_CALIBRATION.markerMs + EQ_CALIBRATION.guardMs,
        separatorMarker: EQ_CALIBRATION.silenceMs + EQ_CALIBRATION.markerMs + EQ_CALIBRATION.guardMs + EQ_CALIBRATION.sweepMs,
        rightSweep: EQ_CALIBRATION.silenceMs + EQ_CALIBRATION.markerMs * 2 + EQ_CALIBRATION.guardMs * 2 + EQ_CALIBRATION.sweepMs,
        endMarker: EQ_CALIBRATION.silenceMs + EQ_CALIBRATION.markerMs * 2 + EQ_CALIBRATION.guardMs * 2 + EQ_CALIBRATION.sweepMs * 2
      }
    }
  };
}

function rmsDb(samples, start, count) {
  if (count <= 0 || start < 0 || start >= samples.length) return -120;
  const end = Math.min(samples.length, start + count);
  let energy = 0;
  for (let index = start; index < end; index += 1) energy += samples[index] * samples[index];
  return 20 * Math.log10(Math.max(1e-6, Math.sqrt(energy / Math.max(1, end - start))));
}

function resampleForMarkerScan(samples, sourceRate, targetRate = 24_000) {
  if (sourceRate === targetRate) return samples;
  const output = new Float32Array(Math.floor(samples.length * targetRate / sourceRate));
  const step = sourceRate / targetRate;
  for (let index = 0; index < output.length; index += 1) {
    const position = index * step;
    const before = Math.floor(position);
    const after = Math.min(samples.length - 1, before + 1);
    const fraction = position - before;
    output[index] = samples[before] + (samples[after] - samples[before]) * fraction;
  }
  return output;
}

const markerWindows = new Map();

function hannWindow(length) {
  let window = markerWindows.get(length);
  if (window) return window;
  window = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (length - 1));
  }
  markerWindows.set(length, window);
  return window;
}

function goertzelPower(samples, start, count, frequency, sampleRate, window) {
  const coefficient = 2 * Math.cos(2 * Math.PI * frequency / sampleRate);
  let previous = 0;
  let previousTwo = 0;
  for (let index = 0; index < count; index += 1) {
    const current = samples[start + index] * window[index] + coefficient * previous - previousTwo;
    previousTwo = previous;
    previous = current;
  }
  return Math.max(0, previousTwo * previousTwo + previous * previous - coefficient * previous * previousTwo);
}

function markerFrame(left, right, start, count, nominalFrequency, sampleRate, window) {
  const scanRatios = Array.from({ length: 41 }, (_, index) => 0.8 + index * 0.01);
  let bestPower = 0;
  let bestFrequency = nominalFrequency;
  for (const ratio of scanRatios) {
    const frequency = nominalFrequency * ratio;
    const power = Math.max(
      goertzelPower(left, start, count, frequency, sampleRate, window),
      goertzelPower(right, start, count, frequency, sampleRate, window)
    );
    if (power > bestPower) {
      bestPower = power;
      bestFrequency = frequency;
    }
  }
  const noiseRatios = [0.65, 0.72, 1.3, 1.4];
  const noisePower = noiseRatios.reduce((total, ratio) => total + Math.max(
    goertzelPower(left, start, count, nominalFrequency * ratio, sampleRate, window),
    goertzelPower(right, start, count, nominalFrequency * ratio, sampleRate, window)
  ), 0) / noiseRatios.length;
  const windowSum = window.reduce((total, value) => total + value, 0);
  const amplitude = 2 * Math.sqrt(bestPower) / windowSum;
  return {
    frequency: bestFrequency,
    levelDb: 20 * Math.log10(Math.max(1e-8, amplitude)),
    snrDb: 10 * Math.log10((bestPower + 1e-12) / (noisePower + 1e-12))
  };
}

function spectralMarkerCandidates(left, right, nominalFrequency, sampleRate) {
  const windowSize = Math.min(1_024, 2 ** Math.floor(Math.log2(sampleRate * 0.08)));
  const hopSize = Math.max(1, Math.round(sampleRate * 0.04));
  const window = hannWindow(windowSize);
  const frames = [];
  for (let start = 0; start + windowSize <= left.length; start += hopSize) {
    frames.push({ start, ...markerFrame(left, right, start, windowSize, nominalFrequency, sampleRate, window) });
  }
  const candidates = [];
  let run = [];
  const finishRun = () => {
    if (!run.length) return;
    const duration = (run.at(-1).start + windowSize - run[0].start) / sampleRate;
    if (duration >= 0.22) {
      const weights = run.map((frame) => Math.pow(10, Math.min(40, frame.snrDb) / 10));
      const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
      const frequency = run.reduce((sum, frame, index) => sum + frame.frequency * weights[index], 0) / weightTotal;
      const variance = run.reduce((sum, frame, index) =>
        sum + Math.pow(frame.frequency - frequency, 2) * weights[index], 0) / weightTotal;
      const snrDb = run.reduce((sum, frame) => sum + frame.snrDb, 0) / run.length;
      const levelDb = Math.max(...run.map((frame) => frame.levelDb));
      const stability = Math.sqrt(variance) / nominalFrequency;
      candidates.push({
        onsetSeconds: run[0].start / sampleRate,
        endSeconds: (run.at(-1).start + windowSize) / sampleRate,
        duration,
        frequency,
        snrDb,
        levelDb,
        stability,
        strong: duration >= 0.38 && snrDb >= 7 && levelDb >= -52,
        score: snrDb + Math.min(1.2, duration) * 12 - stability * 90
      });
    }
    run = [];
  };
  for (const frame of frames) {
    if (frame.snrDb >= 4 && frame.levelDb >= -58) run.push(frame);
    else finishRun();
  }
  finishRun();
  return candidates;
}

function chooseMarkerSequence(startCandidates, separatorCandidates, endCandidates, durationSeconds) {
  const expectedInterval = 11.5;
  let best = null;
  for (const start of startCandidates.filter((candidate) => candidate.strong)) {
    for (const separator of separatorCandidates.filter((candidate) => candidate.strong)) {
      const firstInterval = separator.onsetSeconds - start.onsetSeconds;
      if (firstInterval < 8.5 || firstInterval > 15) continue;
      for (const end of endCandidates) {
        const secondInterval = end.onsetSeconds - separator.onsetSeconds;
        if (secondInterval < 8.5 || secondInterval > 15) continue;
        if (Math.abs(firstInterval - secondInterval) > 1.5) continue;
        const timingPenalty = Math.abs(firstInterval - secondInterval) * 10 +
          Math.abs((firstInterval + secondInterval) / 2 - expectedInterval) * 1.5;
        const score = start.score + separator.score + end.score - timingPenalty;
        if (!best || score > best.score) best = { start, separator, end, score };
      }
      if (!best) {
        const inferredTime = separator.onsetSeconds + firstInterval;
        if (inferredTime + 0.5 < durationSeconds) {
          const score = start.score + separator.score - Math.abs(firstInterval - expectedInterval) * 2 - 20;
          if (!best || score > best.score) {
            best = {
              start,
              separator,
              end: {
                onsetSeconds: inferredTime,
                endSeconds: inferredTime + 1,
                duration: 1,
                frequency: 3_000 / (firstInterval / expectedInterval),
                snrDb: 0,
                levelDb: -120,
                stability: 0,
                strong: false,
                inferred: true,
                score: -20
              },
              score
            };
          }
        }
      }
    }
  }
  return best;
}

function measureSweep(samples, sweepStart, sweepEnd, timeScale, sampleRate) {
  const frequencyRatio = EQ_CALIBRATION.sweepEndHz / EQ_CALIBRATION.sweepStartHz;
  const length = sweepEnd - sweepStart;
  const window = Math.max(512, Math.round(sampleRate * 0.06 * timeScale));
  return EQ_CALIBRATION.frequencies.map((frequency) => {
    const progress = Math.log(frequency / EQ_CALIBRATION.sweepStartHz) / Math.log(frequencyRatio);
    const center = sweepStart + Math.round(length * progress);
    const start = clamp(center - Math.floor(window / 2), sweepStart, Math.max(sweepStart, sweepEnd - window));
    return rmsDb(samples, start, window);
  });
}

function estimateNoise(samples, startMarker, endMarker, timeScale, sampleRate) {
  const window = sampleRate;
  const estimates = [];
  if (startMarker >= window) estimates.push(rmsDb(samples, startMarker - window, window));
  const afterEndMarker = endMarker + Math.round(EQ_CALIBRATION.markerMs / 1_000 * sampleRate * timeScale);
  if (afterEndMarker + window <= samples.length) estimates.push(rmsDb(samples, afterEndMarker, window));
  return estimates.length ? Math.max(...estimates) : -90;
}

function measureToneThd(samples, marker, timeScale, sampleRate) {
  if (marker.inferred) return null;
  const markerSamples = Math.round(EQ_CALIBRATION.markerMs / 1_000 * sampleRate * timeScale);
  const start = marker.onset + Math.round(markerSamples * 0.18);
  const count = Math.min(Math.round(markerSamples * 0.64), samples.length - start);
  if (count < 1_024) return null;
  const window = hannWindow(count);
  const fundamentalHz = marker.frequency;
  const fundamentalPower = goertzelPower(samples, start, count, fundamentalHz, sampleRate, window);
  if (fundamentalPower <= 1e-12) return null;
  let harmonicPower = 0;
  for (let harmonic = 2; harmonic <= 10 && fundamentalHz * harmonic < sampleRate * 0.46; harmonic += 1) {
    harmonicPower += goertzelPower(samples, start, count, fundamentalHz * harmonic, sampleRate, window);
  }
  return clamp(Math.sqrt(harmonicPower / fundamentalPower) * 100, 0, 100);
}

const yieldAnalysis = () => new Promise((resolve) => setTimeout(resolve, 0));

export async function analyzeRecordedEqCalibration({ left, right, sampleRate }, onProgress = () => {}) {
  if (!(left instanceof Float32Array) || !(right instanceof Float32Array) || left.length !== right.length) {
    throw new Error("A stereo recording is required for separate left and right calibration.");
  }
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000) throw new Error("The recording has an unsupported sample rate.");
  const durationSeconds = left.length / sampleRate;
  if (durationSeconds < 22) throw new Error("The recording is too short. Upload the complete calibration playback, including all three markers.");
  if (durationSeconds > 180) throw new Error("The recording is longer than 3 minutes. Trim it to the calibration playback and try again.");

  const markerSampleRate = 24_000;
  onProgress({ stage: "markers", progress: 28, detail: "Preparing a harmonic-tolerant spectral scan…" });
  await yieldAnalysis();
  const markerLeft = resampleForMarkerScan(left, sampleRate, markerSampleRate);
  const markerRight = resampleForMarkerScan(right, sampleRate, markerSampleRate);
  onProgress({ stage: "markers", progress: 38, detail: "Finding sustained energy around the 1 kHz start marker…" });
  await yieldAnalysis();
  const startCandidates = spectralMarkerCandidates(markerLeft, markerRight, 1_000, markerSampleRate);
  onProgress({ stage: "markers", progress: 49, detail: "Finding the 2 kHz channel separator…" });
  await yieldAnalysis();
  const separatorCandidates = spectralMarkerCandidates(markerLeft, markerRight, 2_000, markerSampleRate);
  onProgress({ stage: "markers", progress: 60, detail: "Finding the 3 kHz end marker and verifying marker spacing…" });
  await yieldAnalysis();
  const endCandidates = spectralMarkerCandidates(markerLeft, markerRight, 3_000, markerSampleRate);
  const sequence = chooseMarkerSequence(startCandidates, separatorCandidates, endCandidates, durationSeconds);
  if (!sequence) {
    const candidateTimes = (candidates) => candidates.map((candidate) => candidate.onsetSeconds.toFixed(1)).join(",") || "none";
    throw new Error(
      `Could not identify a valid 1/2/3 kHz marker sequence ` +
      `(candidate times: ${candidateTimes(startCandidates)} / ${candidateTimes(separatorCandidates)} / ${candidateTimes(endCandidates)} s). ` +
      `Check that the complete stereo calibration recording was uploaded.`
    );
  }
  const startMarker = { ...sequence.start, onset: Math.round(sequence.start.onsetSeconds * sampleRate) };
  const separatorMarker = { ...sequence.separator, onset: Math.round(sequence.separator.onsetSeconds * sampleRate) };
  const endMarker = { ...sequence.end, onset: Math.round(sequence.end.onsetSeconds * sampleRate) };
  const expectedInterval = 11.5 * sampleRate;
  const leftTimeScale = (separatorMarker.onset - startMarker.onset) / expectedInterval;
  const rightTimeScale = (endMarker.onset - separatorMarker.onset) / expectedInterval;
  if (leftTimeScale < 0.8 || leftTimeScale > 1.25 || rightTimeScale < 0.8 || rightTimeScale > 1.25) {
    throw new Error("The markers were found, but their timing is invalid. The calibration signal must play continuously without pausing.");
  }
  if (Math.abs(leftTimeScale - rightTimeScale) > 0.06) {
    throw new Error("Tape speed changed too much between sweeps. Check the deck transport and record again.");
  }
  const timeScale = (leftTimeScale + rightTimeScale) / 2;
  const markerDetail = [startMarker, separatorMarker, endMarker].map((marker, index) => {
    const label = `${index + 1} kHz`;
    return marker.inferred
      ? `${label} inferred at ${marker.onsetSeconds.toFixed(2)} s`
      : `${label} ${marker.frequency.toFixed(0)} Hz at ${marker.onsetSeconds.toFixed(2)} s (${marker.snrDb.toFixed(0)} dB)`;
  }).join(" · ");
  onProgress({ stage: "sweeps", progress: 76, detail: `${markerDetail} · measuring sweeps…` });
  await yieldAnalysis();
  const sweepLeadSeconds = (EQ_CALIBRATION.markerMs + EQ_CALIBRATION.guardMs) / 1_000;
  const leftSweepStart = startMarker.onset + Math.round(sweepLeadSeconds * sampleRate * leftTimeScale);
  const rightSweepStart = separatorMarker.onset + Math.round(sweepLeadSeconds * sampleRate * rightTimeScale);
  const leftDb = measureSweep(left, leftSweepStart, separatorMarker.onset, leftTimeScale, sampleRate);
  const rightDb = measureSweep(right, rightSweepStart, endMarker.onset, rightTimeScale, sampleRate);
  const measurement = {
    frequencies: [...EQ_CALIBRATION.frequencies],
    leftDb,
    rightDb,
    leftSweepLeakDb: measureSweep(right, leftSweepStart, separatorMarker.onset, leftTimeScale, sampleRate),
    rightSweepLeakDb: measureSweep(left, rightSweepStart, endMarker.onset, rightTimeScale, sampleRate),
    leftNoiseDb: estimateNoise(left, startMarker.onset, endMarker.onset, timeScale, sampleRate),
    rightNoiseDb: estimateNoise(right, startMarker.onset, endMarker.onset, timeScale, sampleRate),
    thdPercent: {
      left: measureToneThd(left, startMarker, timeScale, sampleRate),
      right: measureToneThd(right, startMarker, timeScale, sampleRate)
    },
    speedRatio: 1 / timeScale,
    durationSeconds,
    markersSeconds: {
      start: startMarker.onset / sampleRate,
      separator: separatorMarker.onset / sampleRate,
      end: endMarker.onset / sampleRate
    },
    markers: [startMarker, separatorMarker, endMarker].map((marker, index) => ({
      nominalHz: (index + 1) * 1_000,
      frequencyHz: marker.frequency,
      timeSeconds: marker.onsetSeconds,
      snrDb: marker.snrDb,
      stabilityPercent: marker.stability * 100,
      inferred: Boolean(marker.inferred)
    }))
  };
  onProgress({ stage: "complete", progress: 92, detail: "Frequency, noise, distortion, and stereo measurements complete…" });
  await yieldAnalysis();
  return measurement;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function smooth(values) {
  return values.map((value, index) => {
    const previous = values[Math.max(0, index - 1)];
    const next = values[Math.min(values.length - 1, index + 1)];
    return previous * 0.25 + value * 0.5 + next * 0.25;
  });
}

function deriveChannelDiagnostic(measuredDb, noiseDb) {
  const referenceValues = measuredDb.filter((value, index) => {
    const frequency = EQ_CALIBRATION.frequencies[index];
    return frequency >= 400 && frequency <= 4_000 && Number.isFinite(value) && value - noiseDb >= 12;
  });
  const referenceDb = median(referenceValues.length ? referenceValues : measuredDb.filter(Number.isFinite));
  const responseDb = smooth(measuredDb.map((value) => Number.isFinite(value) ? value - referenceDb : 0));
  return { measuredDb, responseDb, noiseDb, referenceDb, snrDb: referenceDb - noiseDb };
}

function bandwidthAt(responseDb, measuredDb, noiseDb, thresholdDb) {
  const usable = EQ_CALIBRATION.frequencies.filter((frequency, index) =>
    responseDb[index] >= -thresholdDb && measuredDb[index] - noiseDb >= 12
  );
  return usable.length ? { lowHz: usable[0], highHz: usable.at(-1) } : { lowHz: null, highHz: null };
}

function medianBand(values, frequencies, predicate) {
  return median(values.filter((value, index) => predicate(frequencies[index], index) && Number.isFinite(value)));
}

export function deriveCassetteDiagnostic(measurement, {
  id,
  name,
  sourceFile = "",
  createdAt = new Date().toISOString()
} = {}) {
  const frequencies = measurement?.frequencies;
  if (!Array.isArray(frequencies) || frequencies.length !== EQ_CALIBRATION.frequencies.length ||
      frequencies.some((frequency, index) => frequency !== EQ_CALIBRATION.frequencies[index])) {
    throw new Error("Diagnostic measurement uses an unsupported frequency grid");
  }
  const left = measurement.leftDb?.map(Number);
  const right = measurement.rightDb?.map(Number);
  if (left?.length !== frequencies.length || right?.length !== frequencies.length) {
    throw new Error("Diagnostic measurement is incomplete");
  }
  const leftNoiseDb = Number.isFinite(Number(measurement.leftNoiseDb)) ? Number(measurement.leftNoiseDb) : -90;
  const rightNoiseDb = Number.isFinite(Number(measurement.rightNoiseDb)) ? Number(measurement.rightNoiseDb) : -90;
  const channels = {
    left: deriveChannelDiagnostic(left, leftNoiseDb),
    right: deriveChannelDiagnostic(right, rightNoiseDb)
  };
  for (const channel of Object.values(channels)) {
    channel.bandwidth3Db = bandwidthAt(channel.responseDb, channel.measuredDb, channel.noiseDb, 3);
    channel.bandwidth6Db = bandwidthAt(channel.responseDb, channel.measuredDb, channel.noiseDb, 6);
  }
  const balanceValues = left.map((value, index) => value - right[index]);
  const channelBalanceDb = medianBand(balanceValues, frequencies, (frequency, index) =>
    frequency >= 400 && frequency <= 4_000 && left[index] - leftNoiseDb >= 12 && right[index] - rightNoiseDb >= 12
  );
  const leftLeak = measurement.leftSweepLeakDb?.map(Number) || [];
  const rightLeak = measurement.rightSweepLeakDb?.map(Number) || [];
  const crosstalkBand = (frequency, index, active, leak, noise) =>
    frequency >= 400 && frequency <= 6_300 && Number.isFinite(leak[index]) && active[index] - noise >= 12;
  const leftToRightDb = leftLeak.length === frequencies.length
    ? medianBand(left.map((value, index) => value - leftLeak[index]), frequencies,
      (frequency, index) => crosstalkBand(frequency, index, left, leftLeak, leftNoiseDb))
    : null;
  const rightToLeftDb = rightLeak.length === frequencies.length
    ? medianBand(right.map((value, index) => value - rightLeak[index]), frequencies,
      (frequency, index) => crosstalkBand(frequency, index, right, rightLeak, rightNoiseDb))
    : null;
  const speedRatio = clamp(Number(measurement.speedRatio) || 1, 0.8, 1.2);
  return {
    version: 1,
    id: String(id || `diagnostic-${Date.now().toString(36)}`),
    name: String(name || "Deck + cassette").trim().slice(0, 80) || "Deck + cassette",
    createdAt,
    sourceFile: String(sourceFile || "").slice(0, 260),
    durationSeconds: Number(measurement.durationSeconds) || 0,
    frequencies: [...frequencies],
    speedRatio,
    speedErrorPercent: (speedRatio - 1) * 100,
    channelBalanceDb,
    thdPercent: {
      left: Number.isFinite(Number(measurement.thdPercent?.left)) ? Number(measurement.thdPercent.left) : null,
      right: Number.isFinite(Number(measurement.thdPercent?.right)) ? Number(measurement.thdPercent.right) : null
    },
    crosstalkDb: {
      leftToRight: Number.isFinite(leftToRightDb) ? leftToRightDb : null,
      rightToLeft: Number.isFinite(rightToLeftDb) ? rightToLeftDb : null
    },
    markers: Array.isArray(measurement.markers) ? measurement.markers : [],
    channels
  };
}

export function normalizeDiagnosticStore(value) {
  const reports = Array.isArray(value?.reports) ? value.reports.filter((report) => {
    return report?.version === 1 && typeof report.id === "string" && typeof report.name === "string" &&
      Array.isArray(report.frequencies) && report.frequencies.length === EQ_CALIBRATION.frequencies.length &&
      [report.channels?.left, report.channels?.right].every((channel) =>
        Array.isArray(channel?.responseDb) && channel.responseDb.length === report.frequencies.length &&
        channel.responseDb.every(Number.isFinite)
      );
  }).slice(0, 50) : [];
  const activeId = reports.some((report) => report.id === value?.activeId) ? value.activeId : reports.at(-1)?.id || "";
  return { version: 1, reports, activeId };
}
