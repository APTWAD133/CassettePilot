import { SIGNAL, symbolsToFrame } from "./signal.js";

export const CARRIER_STOP_MS = 280;
export const DEFAULT_NOISE_GATE_DB = -75;

function goertzelPower(samples, start, length, frequency, sampleRate) {
  const omega = 2 * Math.PI * frequency / sampleRate;
  const coefficient = 2 * Math.cos(omega);
  let q0 = 0;
  let q1 = 0;
  let q2 = 0;
  for (let index = 0; index < length; index += 1) {
    q0 = coefficient * q1 - q2 + (samples[start + index] || 0);
    q2 = q1;
    q1 = q0;
  }
  return q1 * q1 + q2 * q2 - coefficient * q1 * q2;
}

function amplitudeDb(samples, frequency, sampleRate) {
  if (!samples?.length) return -120;
  const power = goertzelPower(samples, 0, samples.length, frequency, sampleRate);
  const amplitude = 2 * Math.sqrt(Math.max(0, power)) / samples.length;
  return 20 * Math.log10(Math.max(1e-6, amplitude));
}

function rmsDb(samples) {
  if (!samples?.length) return -120;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return 20 * Math.log10(Math.max(1e-6, Math.sqrt(sum / samples.length)));
}

function analyzeInputChannel(samples, label, sampleRate, noiseGateDb) {
  let pilotDb = -120;
  let pilotHz = SIGNAL.pilotTone;
  for (let frequency = 5_500; frequency <= 6_500; frequency += 25) {
    const db = amplitudeDb(samples, frequency, sampleRate);
    if (db > pilotDb) {
      pilotDb = db;
      pilotHz = frequency;
    }
  }
  const neighboringDb = Math.max(
    amplitudeDb(samples, Math.max(100, pilotHz - 300), sampleRate),
    amplitudeDb(samples, pilotHz + 300, sampleRate)
  );
  const levelDb = rmsDb(samples);
  return {
    label,
    levelDb,
    pilotDb,
    pilotHz,
    pilotDetected: levelDb > noiseGateDb && pilotDb > -65 && pilotDb - neighboringDb >= 3
  };
}

export function analyzeInputSignal(
  left,
  right = null,
  sampleRate = SIGNAL.sampleRate,
  noiseGateDb = DEFAULT_NOISE_GATE_DB
) {
  const normalizedNoiseGateDb = Math.max(-90, Math.min(-20, Number(noiseGateDb) || DEFAULT_NOISE_GATE_DB));
  const channels = [analyzeInputChannel(left, "L", sampleRate, normalizedNoiseGateDb)];
  if (right instanceof Float32Array && right !== left) {
    channels.push(analyzeInputChannel(right, "R", sampleRate, normalizedNoiseGateDb));
  }
  const strongest = [...channels].sort((a, b) => b.pilotDb - a.pilotDb)[0];
  const levelDb = Math.max(...channels.map((channel) => channel.levelDb));
  return {
    channels,
    levelDb,
    inputDetected: levelDb > normalizedNoiseGateDb,
    noiseGateDb: normalizedNoiseGateDb,
    pilotDetected: channels.some((channel) => channel.pilotDetected),
    pilotDb: strongest.pilotDb,
    pilotHz: strongest.pilotHz,
    pilotChannel: strongest.label
  };
}

export function smoothInputMetrics(previous, current, alpha = 0.22) {
  if (!current) return null;
  if (!previous) return structuredClone(current);
  const blend = (before, after) => before + (after - before) * alpha;
  const previousChannels = new Map(previous.channels.map((channel) => [channel.label, channel]));
  return {
    ...current,
    levelDb: blend(previous.levelDb, current.levelDb),
    pilotDb: blend(previous.pilotDb, current.pilotDb),
    channels: current.channels.map((channel) => ({
      ...channel,
      levelDb: blend(previousChannels.get(channel.label)?.levelDb ?? channel.levelDb, channel.levelDb),
      pilotDb: blend(previousChannels.get(channel.label)?.pilotDb ?? channel.pilotDb, channel.pilotDb)
    }))
  };
}

export function classifySymbol(samples, start, samplesPerSymbol = SIGNAL.samplesPerSymbol, speed = 1) {
  const length = Math.max(32, Math.round(samplesPerSymbol));
  let best = 0;
  let bestPower = -Infinity;
  let totalPower = 0;
  SIGNAL.tones.forEach((tone, index) => {
    const power = goertzelPower(samples, Math.round(start), length, tone * speed, SIGNAL.sampleRate);
    totalPower += power;
    if (power > bestPower) {
      bestPower = power;
      best = index;
    }
  });
  return { symbol: best, confidence: bestPower / Math.max(1e-9, totalPower) };
}

function decodeMonoFrame(samples, start = 0, options = {}) {
  const samplesPerSymbol = options.samplesPerSymbol || SIGNAL.samplesPerSymbol;
  const speed = SIGNAL.samplesPerSymbol / samplesPerSymbol;
  const symbols = [];
  let confidence = 0;
  for (let index = 0; index < SIGNAL.frameSymbols; index += 1) {
    const result = classifySymbol(samples, start + index * samplesPerSymbol, samplesPerSymbol, speed);
    symbols.push(result.symbol);
    confidence += result.confidence;
  }
  return {
    ...symbolsToFrame(symbols),
    confidence: confidence / SIGNAL.frameSymbols,
    speed
  };
}

function inputChannels(samples) {
  if (samples instanceof Float32Array) return [{ label: "MONO", samples }];
  const channels = [];
  if (samples?.left instanceof Float32Array) channels.push({ label: "L", samples: samples.left });
  if (samples?.right instanceof Float32Array && samples.right !== samples.left) {
    channels.push({ label: "R", samples: samples.right });
  }
  if (!channels.length) throw new Error("No PCM input channels");
  return channels;
}

function frameQuality(frame) {
  return frame.confidence - frame.correctedBits * 0.002;
}

export function decodeFrameSamples(samples, start = 0, options = {}) {
  const decoded = [];
  for (const channel of inputChannels(samples)) {
    try {
      decoded.push({ ...decodeMonoFrame(channel.samples, start, options), inputChannel: channel.label });
    } catch {
      // A damaged channel does not prevent the other channel from decoding.
    }
  }
  decoded.sort((a, b) => frameQuality(b) - frameQuality(a));
  if (!decoded.length) throw new Error("No channel produced a valid frame");
  return decoded[0];
}

export function decodeGeneratedSignal(samples) {
  const channel = inputChannels(samples)[0].samples;
  const frames = [];
  const frameSamples = SIGNAL.frameSymbols * SIGNAL.samplesPerSymbol;
  for (let start = 0; start + frameSamples <= channel.length; start += frameSamples) {
    try {
      frames.push({ ...decodeMonoFrame(channel, start), inputChannel: "L" });
    } catch {
      // A partially damaged frame is intentionally ignored.
    }
  }
  return frames;
}

const DEFAULT_SYMBOL_SIZES = [40, 39, 41, 38, 42, 37, 43, 36, 44, 35, 45, 34];
const HEADER_SYMBOLS = [0, 3, 0, 3, 0, 3, 0, 3, 0, 3, 0, 3, 2, 1, 2, 1, 3, 3, 3, 3];

function symbolSizeCandidates(hint) {
  if (!Number.isFinite(hint)) return DEFAULT_SYMBOL_SIZES;
  const center = Math.max(34, Math.min(45, hint));
  return [0, -0.12, 0.12, -0.24, 0.24]
    .map((offset) => Math.max(34, Math.min(45, center + offset)))
    .filter((value, index, values) => values.indexOf(value) === index);
}

function headerScore(samples, start, samplesPerSymbol) {
  const speed = SIGNAL.samplesPerSymbol / samplesPerSymbol;
  let score = 0;
  let confidence = 0;
  for (let index = 0; index < HEADER_SYMBOLS.length; index += 1) {
    const result = classifySymbol(samples, start + index * samplesPerSymbol, samplesPerSymbol, speed);
    if (result.symbol === HEADER_SYMBOLS[index]) score += 1;
    confidence += result.confidence;
  }
  return score + confidence / HEADER_SYMBOLS.length;
}

function refinedCandidates(samples, candidate) {
  const refined = [];
  for (let sizeStep = -8; sizeStep <= 8; sizeStep += 1) {
    const samplesPerSymbol = Math.max(34, Math.min(45, candidate.samplesPerSymbol + sizeStep * 0.01));
    for (let startDelta = -6; startDelta <= 6; startDelta += 1) {
      const start = Math.max(0, candidate.start + startDelta);
      const score = headerScore(samples, start, samplesPerSymbol);
      if (score >= HEADER_SYMBOLS.length + 0.05) {
        refined.push({ start, samplesPerSymbol, score });
      }
    }
  }
  refined.sort((a, b) => b.score - a.score);
  return refined.slice(0, 4);
}

function findFrameInChannel(samples, options = {}) {
  const symbolSizes = options.symbolSizes || symbolSizeCandidates(options.symbolSizeHint);
  const candidates = [];
  const maxStart = Math.min(
    Math.floor(samples.length - SIGNAL.frameSymbols * Math.min(...symbolSizes)),
    SIGNAL.frameSymbols * SIGNAL.samplesPerSymbol
  );
  if (maxStart < 0) return null;

  for (const samplesPerSymbol of symbolSizes) {
    const step = Math.max(5, Math.round(samplesPerSymbol / 4));
    for (let start = 0; start <= maxStart; start += step) {
      const score = headerScore(samples, start, samplesPerSymbol);
      if (score >= HEADER_SYMBOLS.length + 0.05) {
        candidates.push({ start, samplesPerSymbol, score });
        candidates.sort((a, b) => b.score - a.score);
        if (candidates.length > 10) candidates.length = 10;
      }
    }
  }

  const decoded = [];
  const attempted = new Set();
  for (const candidate of candidates) {
    for (const refined of refinedCandidates(samples, candidate)) {
      const key = `${refined.start}:${refined.samplesPerSymbol.toFixed(3)}`;
      if (attempted.has(key)) continue;
      attempted.add(key);
      const needed = Math.ceil(refined.start + SIGNAL.frameSymbols * refined.samplesPerSymbol);
      if (needed > samples.length) continue;
      try {
        decoded.push({
          frame: decodeMonoFrame(samples, refined.start, { samplesPerSymbol: refined.samplesPerSymbol }),
          start: refined.start,
          end: needed,
          samplesPerSymbol: refined.samplesPerSymbol
        });
      } catch {
        // CRC rejects false headers and damaged frames.
      }
    }
  }
  decoded.sort((a, b) => frameQuality(b.frame) - frameQuality(a.frame));
  return decoded[0] || null;
}

export function findFrameInSamples(samples, options = {}) {
  const results = [];
  for (const channel of inputChannels(samples)) {
    const result = findFrameInChannel(channel.samples, options);
    if (result) {
      results.push({
        ...result,
        frame: { ...result.frame, inputChannel: channel.label },
        inputChannel: channel.label
      });
    }
  }
  results.sort((a, b) => frameQuality(b.frame) - frameQuality(a.frame));
  return results[0] || null;
}

export class CarrierGate {
  constructor({ stopMs = CARRIER_STOP_MS, releaseMs = 500 } = {}) {
    this.stopMs = stopMs;
    this.releaseMs = releaseMs;
    this.live = false;
    this.lastDetectedAt = 0;
    this.lastValidFrameAt = 0;
  }

  update({ pilotDetected, validFrame = false, detectedAt = null, now = performance.now() }) {
    if (pilotDetected) this.lastDetectedAt = detectedAt ?? now;
    if (validFrame) this.lastValidFrameAt = now;
    const wasLive = this.live;
    if (!this.live && pilotDetected && (validFrame || now - this.lastValidFrameAt < this.releaseMs)) {
      this.live = true;
    } else if (this.live && now - this.lastDetectedAt >= this.stopMs) {
      this.live = false;
      this.lastValidFrameAt = 0;
    }
    return { live: this.live, changed: wasLive !== this.live };
  }
}
