const PREAMBLE_SYMBOLS = 12;
const SYNC_SYMBOLS = 8;
const PAYLOAD_BYTES = 38;
const PAYLOAD_SYMBOLS = PAYLOAD_BYTES * 7;
const FRAME_SYMBOLS = PREAMBLE_SYMBOLS + SYNC_SYMBOLS + PAYLOAD_SYMBOLS;

export const SIGNAL = Object.freeze({
  version: 2,
  sampleRate: 48_000,
  bitsPerSample: 16,
  channels: 2,
  symbolRate: 1_200,
  samplesPerSymbol: 40,
  tones: [1_200, 2_400, 3_600, 4_800],
  pilotTone: 6_000,
  preambleSymbols: PREAMBLE_SYMBOLS,
  syncWord: 0xddaa,
  syncSymbols: SYNC_SYMBOLS,
  payloadBytes: PAYLOAD_BYTES,
  frameSymbols: FRAME_SYMBOLS,
  frameDurationMs: FRAME_SYMBOLS * 1_000 / 1_200
});

export const FLAGS = Object.freeze({
  playing: 1,
  end: 4,
  preroll: 8
});

export function frameRequestsPlayback(frame) {
  return Boolean(frame?.flags & FLAGS.playing) && !Boolean(frame?.flags & FLAGS.preroll);
}

const PREAMBLE = Array.from(
  { length: SIGNAL.preambleSymbols },
  (_, index) => index % 2 === 0 ? 0 : 3
);

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

export function crc32(bytes, end = bytes.length) {
  let crc = 0xffffffff;
  for (let index = 0; index < end; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function clampInt(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(Number(value) || 0)));
}

function asTrackId(value) {
  try {
    return BigInt(value || 0);
  } catch {
    return 0n;
  }
}

export function packFrame(frame) {
  const bytes = new Uint8Array(SIGNAL.payloadBytes);
  const view = new DataView(bytes.buffer);
  const timelineMs = clampInt(frame.timelineMs, 0, 0xffffffff);
  const gainTargetDelta = clampInt(((frame.gainTargetTimelineMs ?? timelineMs) - timelineMs) / 10, 0, 0xffff);
  view.setUint8(0, SIGNAL.version);
  view.setUint8(1, frame.flags ?? FLAGS.playing);
  view.setUint16(2, frame.sequence ?? 0, true);
  view.setUint32(4, timelineMs, true);
  view.setBigUint64(8, asTrackId(frame.trackId), true);
  view.setUint32(16, clampInt(frame.sourceMs, 0, 0xffffffff), true);
  view.setInt16(20, clampInt((frame.gainDb ?? 0) * 100, -32768, 32767), true);
  view.setUint16(22, gainTargetDelta, true);
  view.setInt16(24, clampInt((frame.gainTargetDb ?? frame.gainDb ?? 0) * 100, -32768, 32767), true);
  view.setBigUint64(26, asTrackId(frame.nextTrackId), true);
  view.setUint32(34, crc32(bytes, 34), true);
  return bytes;
}

export function unpackFrame(bytes) {
  if (bytes.length !== SIGNAL.payloadBytes) throw new Error("Invalid frame length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const expected = view.getUint32(34, true);
  const actual = crc32(bytes, 34);
  if (actual !== expected) throw new Error("CRC mismatch");
  if (view.getUint8(0) !== SIGNAL.version) throw new Error("Unsupported signal version");
  const timelineMs = view.getUint32(4, true);

  return {
    version: SIGNAL.version,
    flags: view.getUint8(1),
    sequence: view.getUint16(2, true),
    timelineMs,
    trackId: view.getBigUint64(8, true).toString(),
    sourceMs: view.getUint32(16, true),
    gainDb: view.getInt16(20, true) / 100,
    gainTargetTimelineMs: timelineMs + view.getUint16(22, true) * 10,
    gainTargetDb: view.getInt16(24, true) / 100,
    nextTrackId: view.getBigUint64(26, true).toString()
  };
}

function byteToBits(byte) {
  return Array.from({ length: 8 }, (_, bit) => (byte >> (7 - bit)) & 1);
}

function bitsToByte(bits) {
  return bits.reduce((value, bit) => (value << 1) | bit, 0);
}

function hammingEncodeNibble(nibble) {
  const bits = new Array(7).fill(0);
  bits[2] = (nibble >> 3) & 1;
  bits[4] = (nibble >> 2) & 1;
  bits[5] = (nibble >> 1) & 1;
  bits[6] = nibble & 1;
  bits[0] = bits[2] ^ bits[4] ^ bits[6];
  bits[1] = bits[2] ^ bits[5] ^ bits[6];
  bits[3] = bits[4] ^ bits[5] ^ bits[6];
  return bits;
}

function hammingDecodeWord(input) {
  const bits = [...input];
  const s1 = bits[0] ^ bits[2] ^ bits[4] ^ bits[6];
  const s2 = bits[1] ^ bits[2] ^ bits[5] ^ bits[6];
  const s4 = bits[3] ^ bits[4] ^ bits[5] ^ bits[6];
  const syndrome = s1 | (s2 << 1) | (s4 << 2);
  if (syndrome > 0) bits[syndrome - 1] ^= 1;
  return {
    nibble: (bits[2] << 3) | (bits[4] << 2) | (bits[5] << 1) | bits[6],
    corrected: syndrome > 0
  };
}

export function encodePayloadBits(bytes) {
  const output = [];
  for (const byte of bytes) {
    output.push(...hammingEncodeNibble(byte >> 4));
    output.push(...hammingEncodeNibble(byte & 0x0f));
  }
  return output;
}

export function decodePayloadBits(bits) {
  if (bits.length === 0 || bits.length % 14 !== 0) throw new Error("Invalid encoded payload");
  const bytes = new Uint8Array(bits.length / 14);
  let correctedBits = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const high = hammingDecodeWord(bits.slice(index * 14, index * 14 + 7));
    const low = hammingDecodeWord(bits.slice(index * 14 + 7, index * 14 + 14));
    correctedBits += Number(high.corrected) + Number(low.corrected);
    bytes[index] = (high.nibble << 4) | low.nibble;
  }
  return { bytes, correctedBits };
}

function pairToSymbol(a, b) {
  return [0, 1, 3, 2][(a << 1) | b];
}

function symbolToPair(symbol) {
  return [[0, 0], [0, 1], [1, 1], [1, 0]][symbol] || [0, 0];
}

function bitsToSymbols(bits) {
  const output = [];
  for (let index = 0; index < bits.length; index += 2) {
    output.push(pairToSymbol(bits[index], bits[index + 1] ?? 0));
  }
  return output;
}

export function frameToSymbols(frame) {
  const syncBits = byteToBits(SIGNAL.syncWord >> 8).concat(byteToBits(SIGNAL.syncWord & 0xff));
  return PREAMBLE.concat(bitsToSymbols(syncBits), bitsToSymbols(encodePayloadBits(packFrame(frame))));
}

export function symbolsToFrame(symbols) {
  if (symbols.length < SIGNAL.frameSymbols) throw new Error("Incomplete frame");
  for (let index = 0; index < PREAMBLE.length; index += 1) {
    if (symbols[index] !== PREAMBLE[index]) throw new Error("Preamble mismatch");
  }
  const bits = symbols.slice(PREAMBLE.length).flatMap(symbolToPair);
  const sync = bitsToByte(bits.slice(0, 8)) << 8 | bitsToByte(bits.slice(8, 16));
  if (sync !== SIGNAL.syncWord) throw new Error("Sync mismatch");
  const decoded = decodePayloadBits(bits.slice(16, 16 + SIGNAL.payloadBytes * 14));
  return { ...unpackFrame(decoded.bytes), correctedBits: decoded.correctedBits };
}

export function renderSymbols(symbols, phaseState = { phase: 0, pilotPhase: 0 }) {
  const samples = new Float32Array(symbols.length * SIGNAL.samplesPerSymbol);
  let offset = 0;
  let phase = phaseState.phase;
  let pilotPhase = phaseState.pilotPhase || 0;
  const pilotIncrement = Math.PI * 2 * SIGNAL.pilotTone / SIGNAL.sampleRate;
  for (const symbol of symbols) {
    const increment = Math.PI * 2 * SIGNAL.tones[symbol] / SIGNAL.sampleRate;
    for (let index = 0; index < SIGNAL.samplesPerSymbol; index += 1) {
      samples[offset] = Math.sin(phase) * 0.68 + Math.sin(pilotPhase) * 0.16;
      phase += increment;
      pilotPhase += pilotIncrement;
      if (phase > Math.PI * 2) phase -= Math.PI * 2;
      if (pilotPhase > Math.PI * 2) pilotPhase -= Math.PI * 2;
      offset += 1;
    }
  }
  phaseState.phase = phase;
  phaseState.pilotPhase = pilotPhase;
  return samples;
}

function stereoSamples(left, right) {
  return { left, right, channels: 2, length: left.length };
}

export function generateSignal(totalDurationMs, frameAtTime) {
  const totalSamples = Math.max(1, Math.round(totalDurationMs * SIGNAL.sampleRate / 1000));
  const left = new Float32Array(totalSamples);
  const right = new Float32Array(totalSamples);
  const phaseState = { phase: 0, pilotPhase: 0 };
  let writeAt = 0;
  let sequence = 0;

  while (writeAt < totalSamples) {
    const referenceMs = Math.min(totalDurationMs, (writeAt / SIGNAL.sampleRate * 1000) + SIGNAL.frameDurationMs);
    const frame = frameAtTime(referenceMs, sequence);
    const rendered = renderSymbols(frameToSymbols({ ...frame, sequence }), phaseState);
    const remaining = Math.min(rendered.length, totalSamples - writeAt);
    left.set(rendered.subarray(0, remaining), writeAt);
    right.set(rendered.subarray(0, remaining), writeAt);
    writeAt += rendered.length;
    sequence = (sequence + 1) & 0xffff;
  }

  const fadeSamples = Math.min(Math.round(SIGNAL.sampleRate * 0.005), Math.floor(totalSamples / 2));
  for (let index = 0; index < fadeSamples; index += 1) {
    const gain = index / fadeSamples;
    left[index] *= gain;
    right[index] *= gain;
    left[totalSamples - 1 - index] *= gain;
    right[totalSamples - 1 - index] *= gain;
  }
  return stereoSamples(left, right);
}

function normalizeStereo(samples) {
  if (samples?.left instanceof Float32Array && samples?.right instanceof Float32Array) return samples;
  if (samples instanceof Float32Array) return stereoSamples(samples, samples);
  throw new Error("Expected PCM samples");
}

export function encodeWav(samples, sampleRate = SIGNAL.sampleRate) {
  const stereo = normalizeStereo(samples);
  const sampleFrames = Math.min(stereo.left.length, stereo.right.length);
  const dataBytes = sampleFrames * 4;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeText = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < sampleFrames; index += 1) {
    const leftSample = Math.max(-1, Math.min(1, stereo.left[index]));
    const rightSample = Math.max(-1, Math.min(1, stereo.right[index]));
    view.setInt16(44 + index * 4, leftSample < 0 ? leftSample * 0x8000 : leftSample * 0x7fff, true);
    view.setInt16(46 + index * 4, rightSample < 0 ? rightSample * 0x8000 : rightSample * 0x7fff, true);
  }
  return buffer;
}

export function downloadSignalWav(samples, filename = "cassette-control.wav") {
  const blob = new Blob([encodeWav(samples)], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
