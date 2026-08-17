export const AUDIO_QUALITY_OPTIONS = Object.freeze([
  { value: "best", label: "Best available" },
  { value: "standard", label: "Standard (128 kbps)" },
  { value: "higher", label: "Higher (192 kbps)" },
  { value: "exhigh", label: "Very high (320 kbps)" },
  { value: "lossless", label: "Lossless" },
  { value: "hires", label: "Hi-Res lossless" },
  { value: "jyeffect", label: "HD surround" },
  { value: "sky", label: "Immersive surround" },
  { value: "dolby", label: "Dolby Atmos" },
  { value: "jymaster", label: "Master quality" }
]);

const AUDIO_QUALITY_VALUES = new Set(AUDIO_QUALITY_OPTIONS.map((option) => option.value));
const CORE_QUALITY_ORDER = Object.freeze(["jymaster", "hires", "lossless", "exhigh", "higher", "standard"]);

export function normalizeAudioQuality(value) {
  const normalized = String(value || "").toLowerCase();
  return AUDIO_QUALITY_VALUES.has(normalized) ? normalized : "best";
}

export function audioQualityLabel(value) {
  const normalized = normalizeAudioQuality(value);
  return AUDIO_QUALITY_OPTIONS.find((option) => option.value === normalized)?.label || "Best available";
}

export function audioQualityFallbackLevels(value) {
  const normalized = normalizeAudioQuality(value);
  if (normalized === "best") return [...CORE_QUALITY_ORDER];
  const coreIndex = CORE_QUALITY_ORDER.indexOf(normalized);
  if (coreIndex >= 0) return CORE_QUALITY_ORDER.slice(coreIndex);
  return [normalized, "hires", "lossless", "exhigh", "higher", "standard"];
}

export function audioQualityFromPlaybackItem(item, attemptedQuality = "standard") {
  const reported = String(item?.level || item?.quality || "").toLowerCase();
  if (AUDIO_QUALITY_VALUES.has(reported) && reported !== "best") return reported;
  const bitrate = Number(item?.br || item?.bitrate || 0);
  if (bitrate >= 900_000) return "lossless";
  if (bitrate >= 256_000) return "exhigh";
  if (bitrate >= 160_000) return "higher";
  if (bitrate > 0) return "standard";
  return attemptedQuality === "best" ? "standard" : normalizeAudioQuality(attemptedQuality);
}

export function playbackQualityResolution(requestedQuality, attemptedQuality, item) {
  const requested = normalizeAudioQuality(requestedQuality);
  const attempted = normalizeAudioQuality(attemptedQuality);
  const actual = audioQualityFromPlaybackItem(item, attempted);
  return {
    requested,
    attempted,
    actual,
    fallback: requested !== "best" && actual !== requested,
    bitrate: Number(item?.br || item?.bitrate || 0) || null
  };
}

export function legacyBitrateForQuality(value) {
  const normalized = normalizeAudioQuality(value);
  if (normalized === "standard") return 128_000;
  if (normalized === "higher") return 192_000;
  return 320_000;
}

export function normalizeDubbingSource(value) {
  return value === "music" ? "music" : "control";
}
