import {
  DEMO_LIBRARY,
  createClip,
  createProject,
  createCollectionMixtape,
  collectionImportPlan,
  duplicateClip,
  findProjectClip,
  overwriteLaneWithClip,
  removeProjectClips,
  recomputeTimeline,
  normalizeMixtapeProject,
  syncActiveSide,
  activateProjectSide,
  cassetteSideCapacityMs,
  snapClipStart,
  splitClip,
  clipDuration,
  addGainPoint,
  moveGainPoint,
  removeGainPoint,
  formatTime,
  frameAt,
  activeClipsAt,
  timelineOrder
} from "./model.js";
import {
  SIGNAL,
  FLAGS,
  frameRequestsPlayback,
  generateSignal,
  downloadSignalWav,
  encodeWav
} from "./signal.js";
import { generateProjectSignal, PREROLL_MS } from "./export-signal.js";
import {
  CARRIER_STOP_MS,
  DEFAULT_NOISE_GATE_DB,
  CarrierGate,
  analyzeInputSignal,
  decodeGeneratedSignal,
  smoothInputMetrics
} from "./decoder.js";
import { cursorAnchoredScrollLeft, editorShortcut, playheadMsFromPointer, wheelZoom } from "./editor-shortcuts.js";
import {
  parseTimedLyrics,
  currentLyricIndex,
  centeredLyricScrollTop,
  shouldRenderPlaybackTrack,
  clipPlaybackProgress,
  interpolateGainEnvelope,
  dbToLinearGain,
  advanceTapeClock,
  reconcileTapeDisplayClock,
  setTapeMediaAudible,
  relocateTapeMedia,
  stopTapeMedia,
  shouldSeekTapeMedia,
  primeTapeMedia
} from "./playback.js";
import { TapeSynchronizer } from "./tape-sync.js";
import {
  AUDIO_QUALITY_OPTIONS,
  audioQualityLabel,
  normalizeAudioQuality,
  normalizeDubbingSource
} from "./audio-options.js";
import {
  collectionNodeKey,
  insertMixtapeInLayout,
  moveMixtapesToGroup,
  moveMixtapesToTopLevel,
  moveTopLevelNode,
  normalizeCollectionLayout,
  parseCollectionNodeKey,
  removeMixtapeFromLayout
} from "./mixtape-collection.js";
import {
  analyzeRecordedEqCalibration,
  deriveCassetteDiagnostic,
  generateEqCalibrationSignal,
  normalizeDiagnosticStore
} from "./eq-calibration.js";
import { normalizeLocale, observeLocalization, setLocale, t } from "./i18n.js";
import { preloadAudioEntries, preflightTrackAccess, uniqueStreamingTracks } from "./music-access.js";

const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [element.id, element])
);

const nativeAudio = window.cassetteNative || null;
const desktopStorage = window.cassetteStorage || null;
let nativeAudioDevices = { inputs: [], outputs: [] };
let webAudioOutputs = [];

let persistedDesktopMixtapes = null;
let persistedDesktopSettings = null;
let persistedDesktopDiagnostics = null;
let desktopStorageLoadError = null;
let desktopSettingsLoadError = null;
let desktopDiagnosticsLoadError = null;
if (desktopStorage) {
  try {
    persistedDesktopMixtapes = await desktopStorage.loadMixtapes();
  } catch (error) {
    desktopStorageLoadError = error;
  }
  try {
    persistedDesktopSettings = await desktopStorage.loadSettings();
  } catch (error) {
    desktopSettingsLoadError = error;
  }
  try {
    persistedDesktopDiagnostics = await desktopStorage.loadDiagnostics();
  } catch (error) {
    desktopDiagnosticsLoadError = error;
  }
}

const MIXTAPE_STORAGE_KEY = "cassettepilot-mixtapes-v1";
const AUDIO_ROUTING_STORAGE_KEY = "cassettepilot-audio-routing-v1";
const DIAGNOSTICS_STORAGE_KEY = "cassettepilot-diagnostics-v1";
function normalizeNoiseGateDb(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(-90, Math.min(-20, Math.round(parsed)))
    : DEFAULT_NOISE_GATE_DB;
}

function normalizeAudioRouting(value) {
  return {
    inputDeviceId: String(value?.inputDeviceId || ""),
    playbackOutputId: String(value?.playbackOutputId || ""),
    dubbingOutputId: String(value?.dubbingOutputId || ""),
    musicQuality: normalizeAudioQuality(value?.musicQuality),
    dubbingSource: normalizeDubbingSource(value?.dubbingSource),
    musicMonitoring: Boolean(value?.musicMonitoring),
    inputNoiseGateDb: normalizeNoiseGateDb(value?.inputNoiseGateDb),
    language: normalizeLocale(value?.language)
  };
}

function restoreAudioRouting(desktopValue = null) {
  if (desktopValue && typeof desktopValue === "object") {
    return normalizeAudioRouting(desktopValue);
  }
  try {
    const value = JSON.parse(localStorage.getItem(AUDIO_ROUTING_STORAGE_KEY));
    return normalizeAudioRouting(value);
  } catch {
    return normalizeAudioRouting(null);
  }
}

function saveAudioRouting() {
  try {
    localStorage.setItem(AUDIO_ROUTING_STORAGE_KEY, JSON.stringify(audioRouting));
  } catch {
    // The desktop JSON store remains authoritative when browser storage is unavailable.
  }
  if (!desktopStorage) return;
  desktopStorage.saveSettings(structuredClone(audioRouting)).catch((error) => {
    notify(`Could not save settings: ${error.message}`);
  });
}

function restoreDiagnostics(desktopValue = null) {
  if (desktopValue && typeof desktopValue === "object") return normalizeDiagnosticStore(desktopValue);
  try {
    return normalizeDiagnosticStore(JSON.parse(localStorage.getItem(DIAGNOSTICS_STORAGE_KEY)));
  } catch {
    return normalizeDiagnosticStore(null);
  }
}

function saveDiagnostics() {
  try {
    localStorage.setItem(DIAGNOSTICS_STORAGE_KEY, JSON.stringify(diagnosticStore));
  } catch {
    // The desktop JSON store remains authoritative when browser storage is unavailable.
  }
  desktopStorage?.saveDiagnostics(structuredClone(diagnosticStore)).catch((error) => {
    notify(`Could not save diagnostic reports: ${error.message}`);
  });
}

function canonicalOutputId(deviceId) {
  return deviceId && deviceId !== "default" ? deviceId : "default";
}

function outputsAreShared() {
  if (nativeAudio && audioRouting.playbackOutputId && audioRouting.dubbingOutputId) {
    const playbackLabel = nativeAudioDevices.outputs.find((device) => device.id === audioRouting.playbackOutputId)?.label;
    const dubbingLabel = webAudioOutputs.find((device) => device.deviceId === audioRouting.dubbingOutputId)?.label;
    if (playbackLabel && dubbingLabel) return playbackLabel === dubbingLabel;
  }
  return canonicalOutputId(audioRouting.playbackOutputId) === canonicalOutputId(audioRouting.dubbingOutputId);
}

function matchingWebPlaybackOutputId(nativeOutputId) {
  if (!nativeAudio || !nativeOutputId) return "";
  const label = nativeAudioDevices.outputs.find((device) => device.id === nativeOutputId)?.label;
  return webAudioOutputs.find((device) => device.label === label)?.deviceId || "";
}

function browserPlaybackOutputId() {
  return nativeAudio
    ? matchingWebPlaybackOutputId(audioRouting.playbackOutputId)
    : audioRouting.playbackOutputId;
}

async function routeMediaElement(media, outputId, { strict = false } = {}) {
  if (typeof media.setSinkId !== "function") {
    if (strict && outputId) throw new Error("Output selection is not supported by this browser");
    return;
  }
  try {
    await media.setSinkId(outputId || "");
  } catch (error) {
    if (strict) throw error;
  }
}

async function routeAudioContext(context, outputId, { strict = false } = {}) {
  if (typeof context?.setSinkId !== "function") {
    if (strict && outputId) throw new Error("Output selection is not supported by this browser");
    return false;
  }
  try {
    await context.setSinkId(outputId || "");
    return true;
  } catch (error) {
    if (strict) throw error;
    return false;
  }
}

class MediaGainRouter {
  constructor({ strictOutput = false } = {}) {
    this.strictOutput = strictOutput;
    this.context = null;
  }

  async attach(media, outputId) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      await routeMediaElement(media, outputId, { strict: this.strictOutput });
      return null;
    }
    if (!this.context || this.context.state === "closed") {
      this.context = new AudioContextClass();
      await routeAudioContext(this.context, outputId, { strict: this.strictOutput });
    }
    const source = this.context.createMediaElementSource(media);
    const gainNode = this.context.createGain();
    source.connect(gainNode).connect(this.context.destination);
    media.volume = 1;
    return gainNode;
  }

  setGain(media, gainNode, gainDb) {
    const linear = dbToLinearGain(gainDb);
    if (gainNode) gainNode.gain.value = linear;
    else media.volume = Math.max(0, Math.min(1, linear));
  }

  async resume() {
    if (this.context?.state === "suspended") await this.context.resume();
  }

  async setOutputDevice(outputId, mediaElements) {
    if (this.context) {
      await routeAudioContext(this.context, outputId, { strict: this.strictOutput });
      return;
    }
    await Promise.all(mediaElements.map((media) =>
      media ? routeMediaElement(media, outputId, { strict: this.strictOutput }) : null
    ));
  }

  reset() {
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") context.close().catch(() => {});
  }
}

let audioRouting = restoreAudioRouting(persistedDesktopSettings);
setLocale(audioRouting.language);
observeLocalization();
let diagnosticStore = restoreDiagnostics(persistedDesktopDiagnostics);
let mixtapeStore = restoreMixtapeStore(persistedDesktopMixtapes);
let project = recomputeTimeline(normalizeMixtapeProject(structuredClone(
  mixtapeStore.items.find((item) => item.id === mixtapeStore.activeId) || mixtapeStore.items[0]
)));
let library = [...DEMO_LIBRARY];
let libraryMode = "tracks";
let librarySearchRequestId = 0;
let expandedCollectionKey = null;
const collectionDetails = new Map();
let pendingCollectionImport = null;
let mixtapeSearchQuery = "";
let pendingDeleteSelectionKeys = [];
let pendingGroupMixtapeIds = [];
let pendingRenameCollectionKey = null;
let selectedCollectionKeys = new Set();
let collectionSelectionAnchor = null;
let collectionDragKey = null;
let collectionDragMixtapeIds = [];
let collectionDropTarget = null;
let mixtapeGroupSeed = 0;
let selectedClipId = project.clips[0]?.id || project.bufferClips[0]?.id || null;
let selectedClipIds = new Set(selectedClipId ? [selectedClipId] : []);
let playheadMs = 0;
let zoom = Number(elements.zoom.value);
let previewPlaying = false;
let previewAnimationFrame = 0;
let previewLastTick = 0;
let previewLastAudioSyncAt = 0;
let tapePlaying = false;
let tapeAnimationFrame = 0;
let tapeClock = null;
let toastTimer = 0;
let autosaveTimer = 0;
let persistenceRevision = 0;
let generatedSamples = null;
let liveInput = null;
let providerState = { available: false, authenticated: false };
let loginPollTimer = 0;
let clipClipboard = [];
let dragState = null;
let libraryDragTrack = null;
let pasteTarget = { zone: "timeline", xMs: null, y: 0 };
let gainDragState = null;
let marqueeState = null;
let rulerScrubState = null;
let activeEditorPointerZone = null;
let focusedEditorZone = null;
let dubbingSession = null;
let preparedDubbing = null;
let dubbingPreloadPending = false;
let dubbingPreloadGeneration = 0;
let dubbingEncodeCache = null;
let eqCalibrationAudio = null;
let eqAnalysisGeneration = 0;
let suppressClipClickUntil = 0;
let appMode = "edit";
let inspectorPreview = null;
let inspectorPreviewFrame = 0;
let tapeInputState = "idle";
let tapeCarrierLive = false;
let tapeHasPosition = false;
let lastInputMetrics = null;
let lastInputMetricsAt = 0;
let playbackClipId = null;
let playbackLyrics = [];
let playbackLyricIndex = -2;
const playbackMetadata = new Map();
const playbackMetadataRequests = new Set();
const playbackStreamQuality = new Map();
const tapeSynchronizer = new TapeSynchronizer();
const history = { undo: [], redo: [] };
const HISTORY_LIMIT = 100;
const INPUT_METRICS_FRESH_MS = 150;
const INPUT_DISPLAY_HOLD_MS = 500;
const PROJECT_AUTOSAVE_DELAY_MS = 350;

function showProviderWarning(feature = "use this feature") {
  const dialog = elements["provider-warning-dialog"];
  elements["provider-warning-message"].textContent = `Connect to the music API before you ${feature}.`;
  if (!dialog.open) dialog.showModal();
}

function requireProviderConnection(feature) {
  if (providerState.authenticated) return true;
  showProviderWarning(feature);
  return false;
}

function traceTape(event, details = {}) {
  console.info(`[tape] ${event} ${JSON.stringify({ at: Math.round(performance.now()), ...details })}`);
}

class AudioPlaybackEngine {
  constructor({
    outputDeviceId = () => browserPlaybackOutputId(),
    strictOutput = false,
    waitForMetadata = false,
    strictPlayback = false
  } = {}) {
    this.entries = new Map();
    this.reportedFailures = new Set();
    this.outputDeviceId = outputDeviceId;
    this.strictOutput = strictOutput;
    this.waitForMetadata = waitForMetadata;
    this.strictPlayback = strictPlayback;
    this.gainRouter = new MediaGainRouter({ strictOutput });
  }

  async load(clip) {
    const existing = this.entries.get(clip.id);
    if (existing) return existing;
    const entry = { audio: null, gainNode: null, loading: true, failed: false, resolution: null };
    this.entries.set(clip.id, entry);
    try {
      let url = clip.audioUrl;
      if (!url) {
        if (!requireProviderConnection("play music from NetEase")) {
          throw new Error("Music API connection required");
        }
        const quality = encodeURIComponent(audioRouting.musicQuality);
        const trackId = encodeURIComponent(clip.neteaseId);
        const response = await fetch(
          `/api/netease/url?id=${trackId}&level=${quality}`
        );
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.message || payload.detail || "Provider unavailable");
        entry.resolution = payload.resolution || null;
        const resolvedUrl = payload.data?.[0]?.url || payload.url;
        if (resolvedUrl) url = `/api/netease/stream?id=${trackId}&level=${quality}`;
      }
      if (!url) throw new Error("No playable URL returned");
      const audio = new Audio(url);
      audio.preload = "auto";
      entry.gainNode = await this.gainRouter.attach(audio, this.outputDeviceId());
      if (this.waitForMetadata) await waitForMediaMetadata(audio);
      entry.audio = audio;
    } catch (error) {
      entry.failed = true;
      entry.error = error;
      const failureKey = clip.neteaseId || clip.id;
      if (!this.reportedFailures.has(failureKey)) {
        this.reportedFailures.add(failureKey);
        notify(`${clip.title}: ${error.message || "No playable NetEase URL is available"}`);
      }
    } finally {
      entry.loading = false;
    }
    return entry;
  }

  async sync(timelineMs, shouldPlay) {
    if (!project.clips.length) return;
    const active = activeClipsAt(project, Math.min(timelineMs, Math.max(0, project.totalDurationMs - 1)));
    const activeIds = new Set(active.map(({ clip }) => clip.id));

    for (const [clipId, entry] of this.entries) {
      if (!activeIds.has(clipId) && entry.audio && !entry.audio.paused) entry.audio.pause();
    }

    if (!shouldPlay) return;
    for (const state of active) {
      const entry = await this.load(state.clip);
      if (!entry.audio) {
        if (this.strictPlayback) throw entry.error || new Error(`${state.clip.title} is unavailable for dubbing`);
        continue;
      }
      try {
        await this.gainRouter.resume();
      } catch (error) {
        if (this.strictPlayback) throw error;
      }
      const targetSeconds = state.sourceMs / 1000;
      if (Math.abs(entry.audio.currentTime - targetSeconds) > 1.25) {
        entry.audio.currentTime = targetSeconds;
      }
      this.gainRouter.setGain(entry.audio, entry.gainNode, state.gainDb);
      if (entry.audio.paused) {
        const playback = entry.audio.play();
        if (this.strictPlayback) await playback;
        else playback.catch(() => {});
      }
    }

    const currentClip = active[0]?.clip;
    const linkedNext = currentClip?.nextClipId
      ? project.clips.find((clip) => clip.id === currentClip.nextClipId)
      : null;
    const upcoming = linkedNext && linkedNext.startMs - timelineMs <= 15_000
      ? linkedNext
      : timelineOrder(project).find((clip) =>
          clip.startMs > timelineMs && clip.startMs - timelineMs <= 15_000
        );
    if (upcoming) this.load(upcoming);
  }

  pauseAll() {
    for (const entry of this.entries.values()) entry.audio?.pause();
  }

  async setOutputDevice(deviceId) {
    await this.gainRouter.setOutputDevice(
      deviceId,
      [...this.entries.values()].map((entry) => entry.audio)
    );
  }

  relocate(timelineMs) {
    for (const clip of project.clips) {
      const entry = this.entries.get(clip.id);
      if (!entry?.audio) continue;
      if (timelineMs >= clip.startMs && timelineMs < clip.endMs) {
        entry.audio.currentTime = (clip.trimStartMs + timelineMs - clip.startMs) / 1000;
      } else {
        entry.audio.pause();
      }
    }
  }

  reset() {
    this.pauseAll();
    this.gainRouter.reset();
    this.entries.clear();
    this.reportedFailures.clear();
  }
}

class TapePlaybackEngine {
  constructor() {
    this.entries = new Map();
    this.envelopes = new Map();
    this.generation = 0;
    this.reportedFailures = new Set();
    this.gainRouter = new MediaGainRouter();
  }

  async load(trackId) {
    if (!trackId || trackId === "0") return null;
    let entry = this.entries.get(trackId);
    if (entry) {
      await entry.promise;
      return entry;
    }
    entry = {
      audio: null,
      gainNode: null,
      promise: null,
      failed: false,
      resolution: null,
      pendingSeekTarget: null,
      priming: null
    };
    entry.promise = (async () => {
      try {
        if (!requireProviderConnection("play music from the cassette signal")) {
          throw new Error("Music API connection required");
        }
        traceTape("load-start", { trackId });
        const response = await fetch(
          `/api/netease/url?id=${encodeURIComponent(trackId)}&level=${encodeURIComponent(audioRouting.musicQuality)}`
        );
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.message || payload.detail || "Provider unavailable");
        entry.resolution = payload.resolution || null;
        if (entry.resolution) playbackStreamQuality.set(trackId, entry.resolution);
        const resolvedUrl = payload.data?.[0]?.url || payload.url;
        if (!resolvedUrl) throw new Error("No playable URL returned");
        const url = `/api/netease/stream?id=${encodeURIComponent(trackId)}&level=${encodeURIComponent(audioRouting.musicQuality)}`;
        traceTape("url-ready", { trackId });
        const audio = new Audio(url);
        audio.preload = "auto";
        audio.style.position = "fixed";
        audio.style.width = "1px";
        audio.style.height = "1px";
        audio.style.opacity = "0";
        audio.style.pointerEvents = "none";
        audio.setAttribute("aria-hidden", "true");
        document.body.append(audio);
        entry.gainNode = await this.gainRouter.attach(audio, browserPlaybackOutputId());
        traceTape("output-routed", { trackId, sinkId: audio.sinkId || "default" });
        entry.audio = audio;
        audio.addEventListener("seeked", () => this.finishSeek(entry));
        entry.priming = primeTapeMedia(audio)
          .then((started) => traceTape("prime-settled", { trackId, started }))
          .finally(() => {
            entry.priming = null;
          });
      } catch (error) {
        entry.failed = true;
        traceTape("load-failed", { trackId, error: error?.message || String(error) });
        if (!this.reportedFailures.has(trackId)) {
          this.reportedFailures.add(trackId);
          notify(`NetEase track ${trackId}: ${error.message || "No playable URL is available"}`);
        }
      }
    })();
    this.entries.set(trackId, entry);
    await entry.promise;
    return entry;
  }

  finishSeek(entry) {
    entry.pendingSeekTarget = null;
  }

  prime(trackId) {
    const entry = this.entries.get(trackId);
    if (!entry?.audio || this.envelopes.has(trackId) || entry.priming) return;
    entry.priming = primeTapeMedia(entry.audio).finally(() => {
      entry.priming = null;
    });
  }

  slots(frame) {
    if (!frame || !frame.trackId || frame.trackId === "0") return [];
    return [{
      trackId: frame.trackId,
      sourceMs: frame.sourceMs,
      gainDb: frame.gainDb,
      gainStartTimelineMs: frame.gainStartTimelineMs ?? frame.timelineMs,
      gainTargetTimelineMs: frame.gainTargetTimelineMs,
      gainTargetDb: frame.gainTargetDb
    }];
  }

  async applyFrame(frame, { shouldPlay = false, forceSeek = false } = {}) {
    if (!frame) return;
    const generation = ++this.generation;
    const slots = this.slots(frame);
    const preloadIds = new Set(slots.map((slot) => slot.trackId));
    if (frame.nextTrackId && frame.nextTrackId !== "0") preloadIds.add(frame.nextTrackId);
    await Promise.all([...preloadIds].map((trackId) => this.load(trackId)));
    if (generation !== this.generation) return;

    const activeIds = new Set(slots.map((slot) => slot.trackId));
    const warmTrackId = frame.nextTrackId && frame.nextTrackId !== "0"
      ? frame.nextTrackId
      : null;
    for (const [trackId, entry] of this.entries) {
      if (!activeIds.has(trackId)) {
        this.envelopes.delete(trackId);
        if (trackId === warmTrackId) continue;
        entry.pendingSeekTarget = null;
        entry.audio?.pause();
      }
    }
    for (const slot of slots) {
      const entry = this.entries.get(slot.trackId);
      if (!entry?.audio) continue;
      const targetSeconds = Math.max(0, slot.sourceMs / 1000);
      if (entry.pendingSeekTarget !== null && !entry.audio.seeking) {
        entry.pendingSeekTarget = null;
      }
      const seekPending = entry.audio.seeking || entry.pendingSeekTarget !== null;
      const shouldSeek = shouldSeekTapeMedia(entry.audio.currentTime, targetSeconds, {
        force: forceSeek,
        pending: seekPending
      });
      if (shouldSeek) {
        const relocated = relocateTapeMedia(entry.audio, targetSeconds, { audible: shouldPlay });
        entry.pendingSeekTarget = relocated ? targetSeconds : null;
        traceTape(relocated ? "relocate-started" : "relocate-deferred", {
          trackId: slot.trackId,
          targetSeconds,
          readyState: entry.audio.readyState,
          shouldPlay
        });
      } else if (seekPending) {
        setTapeMediaAudible(entry.audio, shouldPlay);
      } else {
        setTapeMediaAudible(entry.audio, shouldPlay);
      }
      this.envelopes.set(slot.trackId, slot);
      const gainDb = interpolateGainEnvelope(slot, frame.timelineMs);
      this.gainRouter.setGain(entry.audio, entry.gainNode, gainDb);
      if (shouldPlay && entry.audio.paused) {
        await this.gainRouter.resume().catch(() => {});
        entry.audio.play()
          .then(() => traceTape("play-started", { trackId: slot.trackId }))
          .catch((error) => traceTape("play-rejected", {
            trackId: slot.trackId,
            error: error?.message || String(error)
          }));
      }
      else if (!shouldPlay && entry.audio.paused) primeTapeMedia(entry.audio);
    }
    if (warmTrackId && !activeIds.has(warmTrackId)) {
      this.prime(warmTrackId);
    }
  }

  updateGains(timelineMs) {
    for (const [trackId, envelope] of this.envelopes) {
      const entry = this.entries.get(trackId);
      if (!entry?.audio) continue;
      const gainDb = interpolateGainEnvelope(envelope, timelineMs);
      this.gainRouter.setGain(entry.audio, entry.gainNode, gainDb);
    }
  }

  pauseAll() {
    this.generation += 1;
    for (const entry of this.entries.values()) {
      entry.pendingSeekTarget = null;
      stopTapeMedia(entry.audio, { keepWarm: false });
    }
  }

  silenceAll() {
    this.generation += 1;
    for (const entry of this.entries.values()) {
      stopTapeMedia(entry.audio, { keepWarm: true });
    }
  }

  async setOutputDevice(deviceId) {
    await this.gainRouter.setOutputDevice(
      deviceId,
      [...this.entries.values()].map((entry) => entry.audio)
    );
  }

  reset() {
    this.pauseAll();
    this.gainRouter.reset();
    for (const entry of this.entries.values()) entry.audio?.remove();
    this.entries.clear();
    this.envelopes.clear();
    this.reportedFailures.clear();
    playbackStreamQuality.clear();
  }
}

const audioEngine = new AudioPlaybackEngine();
const tapeAudioEngine = new TapePlaybackEngine();
const inspectorPreviewGain = new MediaGainRouter();

function selectedProjectClip() {
  return findProjectClip(project, selectedClipId);
}

function setSelectionState(clipIds, primaryClipId = null) {
  const validIds = [...new Set(clipIds || [])].filter((clipId) => findProjectClip(project, clipId));
  const nextPrimary = primaryClipId && validIds.includes(primaryClipId)
    ? primaryClipId
    : validIds[0] || null;
  if (selectedClipId !== nextPrimary) stopInspectorPreview();
  selectedClipIds = new Set(validIds);
  selectedClipId = nextPrimary;
}

function normalizeSelectionState() {
  const validIds = [...selectedClipIds].filter((clipId) => findProjectClip(project, clipId));
  if (selectedClipId && findProjectClip(project, selectedClipId) && !validIds.includes(selectedClipId)) {
    validIds.unshift(selectedClipId);
  }
  setSelectionState(validIds, selectedClipId);
}

function selectedProjectClips() {
  normalizeSelectionState();
  return [...selectedClipIds].map((clipId) => ({ clipId, ...findProjectClip(project, clipId) }));
}

function setInspectorPreviewButton(playing = false) {
  const button = elements["inspector-preview-toggle"];
  button.classList.toggle("playing", playing);
  button.textContent = playing ? "Stop" : "Preview";
}

function stopInspectorPreview({ resetPosition = true } = {}) {
  cancelAnimationFrame(inspectorPreviewFrame);
  inspectorPreviewFrame = 0;
  if (inspectorPreview?.audio) {
    inspectorPreview.audio.pause();
    inspectorPreview.audio.remove();
  }
  inspectorPreview = null;
  inspectorPreviewGain.reset();
  setInspectorPreviewButton(false);
  if (elements["inspector-preview-toggle"]) elements["inspector-preview-toggle"].disabled = !selectedProjectClip();
  if (resetPosition && elements["inspector-preview-seek"]) {
    elements["inspector-preview-seek"].value = "0";
    elements["inspector-preview-time"].textContent = "0:00.0";
  }
}

function updateInspectorPreviewClock() {
  if (!inspectorPreview?.audio) return;
  const { audio, clip } = inspectorPreview;
  const duration = Math.max(1, clipDuration(clip));
  const localMs = Math.max(0, audio.currentTime * 1000 - clip.trimStartMs);
  elements["inspector-preview-seek"].value = String(Math.min(1000, localMs / duration * 1000));
  elements["inspector-preview-time"].textContent = formatTime(localMs, true);
  if (audio.currentTime * 1000 >= clip.trimEndMs || audio.ended) {
    stopInspectorPreview();
    return;
  }
  inspectorPreviewFrame = requestAnimationFrame(updateInspectorPreviewClock);
}

async function startInspectorPreview() {
  const selected = selectedProjectClip();
  if (!selected) return;
  if (!selected.clip.audioUrl && !requireProviderConnection("preview this clip")) return;
  const requestedRatio = Math.min(0.999, Math.max(0, Number(elements["inspector-preview-seek"].value) / 1000));
  setPreviewPlaying(false);
  stopInspectorPreview({ resetPosition: false });
  const { clip } = selected;
  const previewToken = Symbol("inspector-preview");
  inspectorPreview = { audio: null, clip, previewToken };
  elements["inspector-preview-toggle"].disabled = true;
  elements["inspector-preview-toggle"].textContent = "Loading";
  try {
    let url = clip.audioUrl;
    if (!url) {
      const trackId = encodeURIComponent(clip.neteaseId);
      const quality = encodeURIComponent(audioRouting.musicQuality);
      const response = await fetch(`/api/netease/url?id=${trackId}&level=${quality}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || payload.detail || "Provider unavailable");
      if (payload.data?.[0]?.url || payload.url) url = `/api/netease/stream?id=${trackId}&level=${quality}`;
    }
    if (!url) throw new Error("No playable URL returned");
    const audio = new Audio(url);
    audio.preload = "auto";
    const gainNode = await inspectorPreviewGain.attach(audio, browserPlaybackOutputId());
    await waitForMediaMetadata(audio);
    if (selectedClipId !== clip.id || inspectorPreview?.previewToken !== previewToken) {
      audio.remove();
      return;
    }
    audio.currentTime = (clip.trimStartMs + clipDuration(clip) * requestedRatio) / 1000;
    inspectorPreviewGain.setGain(audio, gainNode, clip.gainDb);
    await inspectorPreviewGain.resume();
    inspectorPreview = { audio, clip, gainNode, previewToken };
    await audio.play();
    elements["inspector-preview-toggle"].disabled = false;
    setInspectorPreviewButton(true);
    inspectorPreviewFrame = requestAnimationFrame(updateInspectorPreviewClock);
  } catch (error) {
    stopInspectorPreview();
    elements["inspector-preview-toggle"].disabled = false;
    notify(error.message || "Could not preview this clip");
  }
}

function toggleInspectorPreview() {
  if (inspectorPreview?.audio && !inspectorPreview.audio.paused) stopInspectorPreview();
  else startInspectorPreview();
}

function normalizeStoredMixtapes(value) {
  try {
    const items = Array.isArray(value?.items)
      ? value.items.map((item) => recomputeTimeline(item)).filter((item) => item?.id)
      : [];
    if (items.length) {
      const activeId = items.some((item) => item.id === value.activeId) ? value.activeId : items[0].id;
      const layout = normalizeCollectionLayout(items, value?.groups, value?.order);
      return { activeId, items, ...layout };
    }
  } catch {
    // Try the next persistence source when saved data is invalid.
  }
  return null;
}

function restoreMixtapeStore(desktopValue = null) {
  const desktopCollection = normalizeStoredMixtapes(desktopValue);
  if (desktopCollection) return desktopCollection;

  try {
    const localCollection = normalizeStoredMixtapes(JSON.parse(localStorage.getItem(MIXTAPE_STORAGE_KEY)));
    if (localCollection) return localCollection;
  } catch {
    // Try the legacy single-project save.
  }
  try {
    const legacy = JSON.parse(localStorage.getItem("cassettepilot-project"));
    const legacyTrackIds = Array.isArray(legacy?.clips)
      ? legacy.clips.map((clip) => String(clip.neteaseId))
      : [];
    const untouchedDemo = legacy?.name === "Side A — First Dub" &&
      legacyTrackIds.length === 2 &&
      legacyTrackIds[0] === "186016" &&
      legacyTrackIds[1] === "5257138";
    if (legacy?.clips?.length && !untouchedDemo) {
      const migrated = recomputeTimeline(legacy);
      migrated.name ||= "Imported Mixtape";
      migrated.updatedAt = Date.now();
      return { activeId: migrated.id, items: [migrated], groups: [], order: [{ type: "mixtape", id: migrated.id }] };
    }
  } catch {
    // Ignore an invalid legacy single-project save.
  }
  const first = recomputeTimeline(createProject());
  return { activeId: first.id, items: [first], groups: [], order: [{ type: "mixtape", id: first.id }] };
}

function setAutosaveStatus(message, state = "saved") {
  elements["autosave-label"].textContent = message;
  elements["autosave-status"].classList.toggle("saving", state === "saving");
  elements["autosave-status"].classList.toggle("error", state === "error");
}

function scheduleProjectAutosave() {
  project.name = elements["project-name"].value.trim() || "Untitled Mixtape";
  elements["breadcrumb-mixtape"].textContent = project.name.toUpperCase();
  clearTimeout(autosaveTimer);
  setAutosaveStatus("Saving...", "saving");
  autosaveTimer = setTimeout(() => saveProject(true), PROJECT_AUTOSAVE_DELAY_MS);
}

function persistSavedMixtapes() {
  try {
    localStorage.setItem(MIXTAPE_STORAGE_KEY, JSON.stringify(mixtapeStore));
  } catch {
    // The desktop JSON store remains authoritative when browser storage is unavailable.
  }

  if (!desktopStorage) {
    setAutosaveStatus("Saved locally");
    return;
  }

  const revision = ++persistenceRevision;
  setAutosaveStatus("Saving...", "saving");
  desktopStorage.saveMixtapes(structuredClone(mixtapeStore)).then(() => {
    if (revision === persistenceRevision) setAutosaveStatus("Saved locally");
  }).catch((error) => {
    if (revision !== persistenceRevision) return;
    setAutosaveStatus("Save failed", "error");
    notify(`Could not save mixtapes: ${error.message}`);
  });
}

function saveProject(silent = false) {
  clearTimeout(autosaveTimer);
  autosaveTimer = 0;
  project.name = elements["project-name"].value.trim() || "Untitled Mixtape";
  project.updatedAt = Date.now();
  syncActiveSide(project);
  const index = mixtapeStore.items.findIndex((item) => item.id === project.id);
  const snapshot = structuredClone(project);
  if (index >= 0) mixtapeStore.items[index] = snapshot;
  else {
    mixtapeStore.items.push(snapshot);
    insertMixtapeInLayout(mixtapeStore, project.id);
  }
  mixtapeStore.activeId = project.id;
  persistSavedMixtapes();
  renderMixtapeList();
  if (!silent) notify("Mixtape saved locally");
}

function mixtapeMatchesQuery(item, query) {
  normalizeMixtapeProject(item);
  if (!query) return true;
  const clips = [...item.sides.A.clips, ...item.sides.B.clips];
  return [item.name, ...clips.flatMap((clip) => [clip.title, clip.artist, clip.album])]
    .some((value) => String(value || "").toLowerCase().includes(query));
}

function renderMixtapeNode(item, query) {
  const sideA = item.sides.A;
  const sideB = item.sides.B;
  const clipCount = sideA.clips.length + sideB.clips.length;
  const name = item.name || "Untitled Mixtape";
  const key = collectionNodeKey("mixtape", item.id);
  return `
    <div class="mixtape-node mixtape-item ${item.id === project.id ? "active" : ""} ${selectedCollectionKeys.has(key) ? "selected" : ""}"
      data-node-key="${escapeAttribute(key)}" draggable="${query ? "false" : "true"}">
      <button class="mixtape-open" data-mixtape-id="${escapeAttribute(item.id)}" title="Open ${escapeAttribute(name)}">
        <strong>${escapeHtml(name)}</strong>
        <time>C${Math.round(item.tapeLengthMinutes)}</time>
        <small>${clipCount} track${clipCount === 1 ? "" : "s"} | A ${formatTime(sideA.totalDurationMs)} | B ${formatTime(sideB.totalDurationMs)}</small>
      </button>
    </div>`;
}

function renderMixtapeList() {
  const query = mixtapeSearchQuery.trim().toLowerCase();
  const itemMap = new Map(mixtapeStore.items.map((item) => [item.id, item]));
  const groupMap = new Map(mixtapeStore.groups.map((group) => [group.id, group]));
  const validKeys = new Set([
    ...mixtapeStore.items.map((item) => collectionNodeKey("mixtape", item.id)),
    ...mixtapeStore.groups.map((group) => collectionNodeKey("group", group.id))
  ]);
  selectedCollectionKeys = new Set([...selectedCollectionKeys].filter((key) => validKeys.has(key)));

  let visibleMixtapeCount = 0;
  const nodes = [];
  for (const node of mixtapeStore.order) {
    if (node.type === "mixtape") {
      const item = itemMap.get(node.id);
      if (!item || !mixtapeMatchesQuery(item, query)) continue;
      visibleMixtapeCount += 1;
      nodes.push(renderMixtapeNode(item, query));
      continue;
    }

    const group = groupMap.get(node.id);
    if (!group) continue;
    const groupNameMatches = Boolean(query && group.name.toLowerCase().includes(query));
    const visibleItems = group.itemIds
      .map((id) => itemMap.get(id))
      .filter((item) => item && (groupNameMatches || mixtapeMatchesQuery(item, query)));
    if (query && !groupNameMatches && !visibleItems.length) continue;
    visibleMixtapeCount += visibleItems.length;
    const key = collectionNodeKey("group", group.id);
    const children = visibleItems.length
      ? visibleItems.map((item) => renderMixtapeNode(item, query)).join("")
      : `<div class="mixtape-group-empty" data-group-empty-id="${escapeAttribute(group.id)}">Drop mixtapes here</div>`;
    nodes.push(`
      <section class="mixtape-node mixtape-group ${group.collapsed && !query ? "collapsed" : ""} ${selectedCollectionKeys.has(key) ? "selected" : ""}"
        data-node-key="${escapeAttribute(key)}" draggable="${query ? "false" : "true"}">
        <div class="mixtape-group-header">
          <button class="mixtape-group-toggle" data-toggle-group-id="${escapeAttribute(group.id)}" aria-label="${group.collapsed ? "Expand" : "Collapse"} ${escapeAttribute(group.name)}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <button class="mixtape-group-label" data-select-group-id="${escapeAttribute(group.id)}">${escapeHtml(group.name)}</button>
          <span class="mixtape-group-count">${group.itemIds.length}</span>
        </div>
        <div class="mixtape-group-children">${children}</div>
      </section>`);
  }

  elements["mixtape-count"].textContent = query
    ? `${visibleMixtapeCount}/${mixtapeStore.items.length}`
    : String(mixtapeStore.items.length);
  elements["mixtape-list"].innerHTML = nodes.length
    ? nodes.join("")
    : `<p class="mixtape-empty">${query ? `No mixtapes or groups match “${escapeHtml(mixtapeSearchQuery.trim())}”.` : "Create a mixtape or group to get started."}</p>`;
  elements["breadcrumb-mixtape"].textContent = project.name.toUpperCase();
}

function openMixtape(mixtapeId) {
  if (mixtapeId === project.id) return;
  saveProject(true);
  const stored = mixtapeStore.items.find((item) => item.id === mixtapeId);
  if (!stored) return;
  setPreviewPlaying(false);
  project = recomputeTimeline(normalizeMixtapeProject(structuredClone(stored)));
  setSelectionState([project.clips[0]?.id || project.bufferClips[0]?.id].filter(Boolean));
  playheadMs = 0;
  history.undo.length = 0;
  history.redo.length = 0;
  elements["project-name"].value = project.name;
  audioEngine.reset();
  renderTimeline();
  saveProject(true);
  updateHistoryButtons();
  notify(`${project.name} opened`);
}

function createNewMixtape() {
  saveProject(true);
  const count = mixtapeStore.items.length + 1;
  project = recomputeTimeline(createProject(`Untitled Mixtape ${count}`));
  mixtapeStore.items.push(structuredClone(project));
  insertMixtapeInLayout(mixtapeStore, project.id);
  mixtapeStore.activeId = project.id;
  setSelectionState([]);
  playheadMs = 0;
  history.undo.length = 0;
  history.redo.length = 0;
  elements["project-name"].value = project.name;
  audioEngine.reset();
  renderTimeline();
  saveProject(true);
  updateHistoryButtons();
  elements["project-name"].focus();
  elements["project-name"].select();
  notify("New empty mixtape created");
}

function selectedMixtapeIds(keys = selectedCollectionKeys, { includeGroups = false } = {}) {
  const ids = new Set();
  for (const key of keys) {
    const node = parseCollectionNodeKey(key);
    if (node?.type === "mixtape") ids.add(node.id);
    if (includeGroups && node?.type === "group") {
      const group = mixtapeStore.groups.find((candidate) => candidate.id === node.id);
      for (const itemId of group?.itemIds || []) ids.add(itemId);
    }
  }
  return ids;
}

function orderedSelectedMixtapeIds(keys = selectedCollectionKeys) {
  const selectedIds = selectedMixtapeIds(keys);
  const orderedIds = [];
  for (const node of mixtapeStore.order) {
    if (node.type === "mixtape" && selectedIds.has(node.id)) orderedIds.push(node.id);
    if (node.type === "group") {
      const group = mixtapeStore.groups.find((candidate) => candidate.id === node.id);
      for (const itemId of group?.itemIds || []) {
        if (selectedIds.has(itemId)) orderedIds.push(itemId);
      }
    }
  }
  return orderedIds;
}

function requestDeleteSelection(keys = selectedCollectionKeys) {
  const normalizedKeys = [...keys].filter((key) => parseCollectionNodeKey(key));
  if (!normalizedKeys.length) return;
  const groupCount = normalizedKeys.filter((key) => parseCollectionNodeKey(key)?.type === "group").length;
  const mixtapeIds = selectedMixtapeIds(normalizedKeys, { includeGroups: true });
  if (mixtapeIds.size >= mixtapeStore.items.length) {
    notify("Keep at least one mixtape in the collection");
    return;
  }
  pendingDeleteSelectionKeys = normalizedKeys;
  const mixtapeCount = mixtapeIds.size;
  elements["delete-mixtape-title"].textContent = `Delete ${mixtapeCount + groupCount === 1 ? "selection" : `${mixtapeCount + groupCount} items`}?`;
  elements["delete-mixtape-message"].textContent = groupCount
    ? `${mixtapeCount} mixtape${mixtapeCount === 1 ? "" : "s"} and ${groupCount} group${groupCount === 1 ? "" : "s"} will be removed. Deleting a group also deletes the mixtapes inside it. This cannot be undone.`
    : `${mixtapeCount} mixtape${mixtapeCount === 1 ? "" : "s"} and ${mixtapeCount === 1 ? "its" : "their"} edited sequence${mixtapeCount === 1 ? "" : "s"} will be removed. This cannot be undone.`;
  elements["delete-mixtape-dialog"].showModal();
}

function deletePendingSelection() {
  const keys = pendingDeleteSelectionKeys;
  pendingDeleteSelectionKeys = [];
  if (!keys.length) return;
  const groupIds = new Set(keys.map(parseCollectionNodeKey).filter((node) => node?.type === "group").map((node) => node.id));
  const mixtapeIds = selectedMixtapeIds(keys, { includeGroups: true });
  if (mixtapeIds.size >= mixtapeStore.items.length) return;

  saveProject(true);
  const activeIndex = mixtapeStore.items.findIndex((item) => item.id === project.id);
  mixtapeStore.items = mixtapeStore.items.filter((item) => !mixtapeIds.has(item.id));
  for (const mixtapeId of mixtapeIds) removeMixtapeFromLayout(mixtapeStore, mixtapeId);
  mixtapeStore.groups = mixtapeStore.groups.filter((group) => !groupIds.has(group.id));
  mixtapeStore.order = mixtapeStore.order.filter((node) => !(node.type === "group" && groupIds.has(node.id)));

  if (mixtapeIds.has(project.id)) {
    setPreviewPlaying(false);
    const replacement = mixtapeStore.items[Math.min(Math.max(0, activeIndex), mixtapeStore.items.length - 1)];
    project = recomputeTimeline(normalizeMixtapeProject(structuredClone(replacement)));
    setSelectionState([project.clips[0]?.id || project.bufferClips[0]?.id].filter(Boolean));
    playheadMs = 0;
    history.undo.length = 0;
    history.redo.length = 0;
    elements["project-name"].value = project.name;
    audioEngine.reset();
    renderTimeline();
    updateHistoryButtons();
  }

  selectedCollectionKeys.clear();
  collectionSelectionAnchor = null;
  mixtapeStore.activeId = project.id;
  persistSavedMixtapes();
  renderMixtapeList();
  const deletedCount = mixtapeIds.size + groupIds.size;
  notify(`${deletedCount} item${deletedCount === 1 ? "" : "s"} deleted`);
}

function snapshotEditor() {
  syncActiveSide(project);
  return {
    project: structuredClone(project),
    selectedClipId,
    selectedClipIds: [...selectedClipIds],
    playheadMs
  };
}

function pushHistory() {
  history.undo.push(snapshotEditor());
  if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
  history.redo.length = 0;
  updateHistoryButtons();
}

function restoreEditor(snapshot) {
  setPreviewPlaying(false);
  project = recomputeTimeline(normalizeMixtapeProject(structuredClone(snapshot.project)));
  setSelectionState(snapshot.selectedClipIds || [snapshot.selectedClipId].filter(Boolean), snapshot.selectedClipId);
  playheadMs = Math.min(snapshot.playheadMs, project.totalDurationMs);
  elements["project-name"].value = project.name;
  audioEngine.reset();
  renderTimeline();
  saveProject(true);
}

function undo() {
  const snapshot = history.undo.pop();
  if (!snapshot) return;
  history.redo.push(snapshotEditor());
  restoreEditor(snapshot);
  updateHistoryButtons();
  notify("Undo");
}

function redo() {
  const snapshot = history.redo.pop();
  if (!snapshot) return;
  history.undo.push(snapshotEditor());
  restoreEditor(snapshot);
  updateHistoryButtons();
  notify("Redo");
}

function updateHistoryButtons() {
  elements["undo-action"].disabled = history.undo.length === 0;
  elements["redo-action"].disabled = history.redo.length === 0;
}

function updateClipboardButtons() {
  const hasSelection = Boolean(selectedProjectClip());
  elements["copy-clip"].disabled = !hasSelection;
  elements["paste-clip"].disabled = clipClipboard.length === 0;
}

function notify(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2_600);
}

function waveformBars(seedValue) {
  let seed = [...String(seedValue)].reduce((sum, char) => sum + char.charCodeAt(0), 17);
  const bars = [];
  for (let index = 0; index < 90; index += 1) {
    seed = (seed * 9301 + 49297) % 233280;
    const height = 18 + (seed / 233280) * 75;
    bars.push(`<i style="height:${height.toFixed(1)}%"></i>`);
  }
  return bars.join("");
}

function gainPointY(gainDb) {
  return Math.max(0, Math.min(100, (12 - gainDb) / 72 * 100));
}

function gainPolyline(clip) {
  const duration = Math.max(1, clipDuration(clip));
  return clip.gainPoints
    .map((point) => `${(point.timeMs / duration * 100).toFixed(3)},${gainPointY(point.gainDb).toFixed(3)}`)
    .join(" ");
}

function gainPointMarkup(clip) {
  const duration = Math.max(1, clipDuration(clip));
  return clip.gainPoints.map((point) => `
    <button class="gain-point" data-gain-point-id="${point.id}"
      style="left:${(point.timeMs / duration * 100).toFixed(3)}%; top:${gainPointY(point.gainDb).toFixed(3)}%"
      title="${point.gainDb.toFixed(1)} dB at ${formatTime(point.timeMs, true)}"
      aria-label="Gain point ${point.gainDb.toFixed(1)} decibels at ${formatTime(point.timeMs, true)}"></button>
  `).join("");
}

function libraryThumbnailMarkup(item, index = "") {
  const coverUrl = String(item?.coverUrl || "");
  return `
    <span class="library-thumbnail ${coverUrl ? "" : "missing"}" ${index ? `data-index="${escapeAttribute(index)}"` : ""}>
      ${coverUrl ? `<img src="${escapeAttribute(coverUrl)}" alt="" loading="lazy">` : ""}
      <span>${escapeHtml(artworkInitials(item))}</span>
    </span>
  `;
}

function collectionDropdownMarkup(item) {
  const key = `${item.kind}:${item.id}`;
  const detail = collectionDetails.get(key);
  if (!detail || detail.loading) return `<div class="collection-dropdown"><p class="collection-loading">Loading tracks…</p></div>`;
  if (detail.error) return `<div class="collection-dropdown"><p class="collection-loading">${escapeHtml(detail.error)}</p></div>`;
  return `
    <div class="collection-dropdown">
      <div class="collection-dropdown-header">
        <span>${detail.tracks.length} TRACK${detail.tracks.length === 1 ? "" : "S"} · ${formatTime(detail.tracks.reduce((sum, track) => sum + track.durationMs, 0))}</span>
        <button class="collection-import-button" data-import-collection-key="${escapeAttribute(key)}">IMPORT ALL</button>
      </div>
      <div class="collection-tracks">
        ${detail.tracks.map((track, index) => `
          <button class="collection-track" draggable="true" data-collection-track-key="${escapeAttribute(key)}" data-collection-track-index="${index}" title="Click to add, or drag into the timeline buffer">
            ${libraryThumbnailMarkup(track)}
            <span class="collection-track-meta"><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(track.artist)}</span></span>
            <b>${formatTime(track.durationMs)}</b>
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

function renderLibrary() {
  if (libraryMode === "tracks") {
    elements["library-list"].innerHTML = library.length ? library.map((track, index) => `
      <button class="library-item" draggable="true" data-library-index="${index}" title="Click to append, or drag into the timeline buffer">
        ${libraryThumbnailMarkup(track, String(index + 1).padStart(2, "0"))}
        <span class="library-meta">
          <strong>${escapeHtml(track.title)}</strong>
          <span>${escapeHtml(track.artist)} · ${formatTime(track.durationMs)}</span>
        </span>
      </button>
    `).join("") : `<p class="library-empty">No tracks found. Try another title, artist, or song ID.</p>`;
  } else {
    const noun = libraryMode === "albums" ? "albums" : "playlists";
    elements["library-list"].innerHTML = library.length ? library.map((item, index) => {
      const key = `${item.kind}:${item.id}`;
      const expanded = key === expandedCollectionKey;
      return `
        <article class="collection-result ${expanded ? "expanded" : ""}">
          <button class="collection-item" data-collection-index="${index}" aria-expanded="${expanded}">
            ${libraryThumbnailMarkup(item)}
            <span class="collection-meta">
              <strong>${escapeHtml(item.title)}</strong>
              <span>${escapeHtml(item.subtitle)}</span>
              <small>${item.trackCount} TRACK${item.trackCount === 1 ? "" : "S"}</small>
            </span>
            <span class="collection-chevron">›</span>
          </button>
          ${expanded ? collectionDropdownMarkup(item) : ""}
        </article>
      `;
    }).join("") : `<p class="library-empty">No ${noun} found. Try another search.</p>`;
  }
  elements["library-list"].querySelectorAll(".library-thumbnail img").forEach((image) => {
    image.addEventListener("error", () => image.parentElement.classList.add("missing"), { once: true });
  });
}

function escapeHtml(value) {
  const node = document.createElement("span");
  node.textContent = value ?? "";
  return node.innerHTML;
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function artworkInitials(clip) {
  const words = `${clip?.title || "CassettePilot"}`.trim().split(/\s+/);
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "CC";
}

function setPlaybackArtwork(clip) {
  const shell = elements["playback-cover"].parentElement;
  const url = clip?.coverUrl || "";
  elements["playback-artwork-fallback"].querySelector("span").textContent = artworkInitials(clip);
  shell.classList.toggle("has-cover", Boolean(url));
  if (url) {
    elements["playback-cover"].src = url;
    elements["playback-cover"].alt = `${clip.title} cover`;
    elements["playback-backdrop"].style.backgroundImage = `url(${JSON.stringify(url)})`;
  } else {
    elements["playback-cover"].removeAttribute("src");
    elements["playback-cover"].alt = "Generated cassette artwork";
    elements["playback-backdrop"].style.backgroundImage = "";
  }
}

function renderPlaybackLyrics(lines) {
  playbackLyrics = lines;
  playbackLyricIndex = -2;
  elements["lyrics-language"].textContent = lines.some((line) => line.translation)
    ? "ORIGINAL + TRANSLATION"
    : "ORIGINAL";
  elements["playback-lyrics"].innerHTML = lines.length
    ? lines.map((line, index) => `
        <p class="lyric-line" data-lyric-index="${index}">
          ${escapeHtml(line.text)}
          ${line.translation ? `<span>${escapeHtml(line.translation)}</span>` : ""}
        </p>
      `).join("")
    : '<p class="lyrics-empty">Timed lyrics are not available for this track.</p>';
  elements["playback-lyrics"].scrollTop = 0;
}

function paintPlaybackTrack(clip) {
  if (!clip) {
    elements["playback-title"].textContent = "Waiting for the cassette";
    elements["playback-artist"].textContent = "Start playback or audio input to begin";
    elements["playback-album"].textContent = "—";
    elements["playback-track-id"].textContent = "—";
    elements["playback-lane"].textContent = "NO ACTIVE TRACK";
    elements["playback-quality"].textContent = "-";
    setPlaybackArtwork(null);
    renderPlaybackLyrics([]);
    return;
  }
  elements["playback-title"].textContent = clip.title;
  elements["playback-artist"].textContent = clip.artist;
  elements["playback-album"].textContent = clip.album || "Unknown album";
  elements["playback-track-id"].textContent = clip.neteaseId;
  elements["playback-lane"].textContent = clip.tapeLabel || "TAPE DECK";
  setPlaybackArtwork(clip);
  renderPlaybackLyrics(parseTimedLyrics(clip.lyrics, clip.translatedLyrics));
}

function streamQualityLabel(resolution) {
  if (!resolution?.actual) return "Checking access...";
  const label = t(audioQualityLabel(resolution.actual));
  return resolution.fallback ? `${label} - fallback` : label;
}

function tapeDisplayTrack(trackId) {
  if (!trackId || trackId === "0") return null;
  const metadata = playbackMetadata.get(trackId) || {};
  const song = metadata.song || {};
  const durationMs = Math.max(0, Number(song.durationMs) || 0);
  return {
    id: `tape-${trackId}`,
    neteaseId: trackId,
    title: song.title || `NetEase track ${trackId}`,
    artist: song.artist || "Loading track information…",
    album: song.album || "NetEase Cloud Music",
    coverUrl: song.coverUrl || "",
    lyrics: metadata.lyrics || "",
    translatedLyrics: metadata.translatedLyrics || "",
    durationMs,
    trimStartMs: 0,
    trimEndMs: Math.max(1, durationMs),
    tapeLabel: "TAPE DECK"
  };
}

async function ensureTapeMetadata(trackId) {
  if (!trackId || trackId === "0" || playbackMetadata.has(trackId) || playbackMetadataRequests.has(trackId)) return;
  if (!providerState.authenticated) return;
  playbackMetadataRequests.add(trackId);
  try {
    const response = await fetch(`/api/netease/detail?id=${encodeURIComponent(trackId)}`);
    if (!response.ok) throw new Error("Metadata unavailable");
    playbackMetadata.set(trackId, await response.json());
    const isCurrentTrack = tapeClock?.frame?.trackId === trackId;
    if (isCurrentTrack || tapeClock?.frame?.nextTrackId === trackId) {
      updatePlaybackView(true, { refreshTrack: isCurrentTrack });
    }
  } catch {
    playbackMetadataRequests.delete(trackId);
    if (tapeClock?.frame?.trackId === trackId && !playbackLyrics.length) {
      elements["playback-lyrics"].innerHTML = '<p class="lyrics-empty">Lyrics are unavailable. Playback will continue normally.</p>';
    }
  }
}

function updatePlaybackLyrics(sourceMs) {
  const index = currentLyricIndex(playbackLyrics, sourceMs);
  const container = elements["playback-lyrics"];
  if (index === playbackLyricIndex) return;
  playbackLyricIndex = index;
  container.querySelectorAll(".lyric-line").forEach((line, lineIndex) => {
    line.classList.toggle("active", lineIndex === index);
  });

  const activeLine = container.querySelector(`[data-lyric-index="${index}"]`);
  if (!activeLine) return;
  const containerRect = container.getBoundingClientRect();
  const lineRect = activeLine.getBoundingClientRect();
  const lineTop = lineRect.top - containerRect.top + container.scrollTop;
  const top = centeredLyricScrollTop(
    lineTop,
    lineRect.height,
    container.clientHeight,
    container.scrollHeight
  );
  container.scrollTo({ top, behavior: "smooth" });
}

function updatePlaybackView(force = false, { refreshTrack = false } = {}) {
  if (appMode !== "playback" && !force) return;
  const frame = tapeClock?.frame || null;
  const clip = tapeHasPosition ? tapeDisplayTrack(frame?.trackId) : null;
  if (shouldRenderPlaybackTrack(playbackClipId, clip?.id, { refresh: refreshTrack })) {
    playbackClipId = clip?.id || null;
    paintPlaybackTrack(clip);
    ensureTapeMetadata(frame?.trackId);
  }

  elements["playback-project"].textContent = "Standalone tape player";
  const stateLabel = tapeInputState === "arming"
    ? "REQUESTING AUDIO INPUT"
    : tapeInputState === "error"
      ? "AUDIO INPUT UNAVAILABLE"
      : !liveInput
        ? "AUDIO INPUT NOT ARMED"
        : !tapeHasPosition
          ? "WAITING FOR A VALID TAPE FRAME"
          : frame?.flags & FLAGS.preroll
            ? "CARRIER LOCKED · PRELOADING FIRST SONG"
          : tapePlaying
            ? "CASSETTE SIGNAL · PLAYING"
            : "CASSETTE STOPPED · PAUSED";
  elements["playback-state"].textContent = stateLabel;
  elements["playback-source"].classList.toggle("tape", tapeCarrierLive);
  elements["playback-source"].innerHTML = `<i></i>${tapeCarrierLive ? " TAPE LOCKED" : " WAITING FOR TAPE"}`;
  elements["playback-tape-status"].textContent = tapeCarrierLive
    ? frame?.flags & FLAGS.preroll
      ? "Locked · first song positioned silently"
      : "Carrier and frame locked"
    : tapeInputState === "arming"
      ? "Connecting to the audio input…"
      : liveInput
        ? "Listening for the 6 kHz pilot and a valid frame"
        : "Enter Playback mode again after allowing audio input";
  elements["playback-tape-time"].textContent = formatTime(tapeClock?.timelineMs || 0, true);
  elements["playback-quality"].textContent = clip
    ? streamQualityLabel(playbackStreamQuality.get(frame?.trackId))
    : "-";

  const sourceMs = tapeClock?.sourceMs || 0;
  const durationMs = clip?.durationMs || 0;
  const progress = durationMs > 0 ? clipPlaybackProgress(clip, sourceMs) : 0;
  const elapsedMs = clip ? sourceMs : 0;
  elements["playback-progress-fill"].style.width = `${(progress * 100).toFixed(3)}%`;
  elements["playback-progress"].setAttribute("aria-valuenow", String(Math.round(progress * 100)));
  elements["playback-song-time"].textContent = formatTime(elapsedMs, true);
  elements["playback-song-duration"].textContent = durationMs ? formatTime(durationMs, true) : "—:—";
  updatePlaybackLyrics(sourceMs);

  const nextId = frame?.nextTrackId && frame.nextTrackId !== "0" ? frame.nextTrackId : null;
  const next = nextId ? tapeDisplayTrack(nextId) : null;
  ensureTapeMetadata(nextId);
  elements["playback-next-title"].textContent = next?.title || "End of side";
  elements["playback-next-artist"].textContent = next?.artist || "No following clip";
}

function setMode(mode, { armInput = false } = {}) {
  if (mode === "playback" && !requireProviderConnection("enter cassette playback mode")) return;
  const previousMode = appMode;
  appMode = mode === "playback" || mode === "monitor" ? mode : "edit";
  if (appMode !== "edit") {
    setPreviewPlaying(false);
    stopInspectorPreview();
  }
  if (appMode === "edit" && previousMode !== "edit" && liveInput) stopLiveInput();
  document.body.dataset.mode = appMode;
  elements["mode-edit"].classList.toggle("active", appMode === "edit");
  elements["mode-playback"].classList.toggle("active", appMode === "playback");
  elements["mode-monitor"].classList.toggle("active", appMode === "monitor");
  elements["mode-edit"].setAttribute("aria-pressed", String(appMode === "edit"));
  elements["mode-playback"].setAttribute("aria-pressed", String(appMode === "playback"));
  elements["mode-monitor"].setAttribute("aria-pressed", String(appMode === "monitor"));
  if (appMode === "playback") {
    updatePlaybackView(true);
    if (armInput && !liveInput && tapeInputState !== "arming") startLiveInput();
  }
  else if (appMode === "edit") renderTimeline();
}

function pixelsPerSecond() {
  return zoom;
}

function updateCassetteControls() {
  const side = project.activeSide;
  const capacityMs = cassetteSideCapacityMs(project);
  const tapeMinutes = Math.round(project.tapeLengthMinutes * 10) / 10;
  elements["side-a"].classList.toggle("active", side === "A");
  elements["side-b"].classList.toggle("active", side === "B");
  elements["side-a"].setAttribute("aria-pressed", String(side === "A"));
  elements["side-b"].setAttribute("aria-pressed", String(side === "B"));
  elements["track-side-label"].textContent = `${side}1`;
  elements["tape-length-custom"].value = String(tapeMinutes);
  elements["tape-length-slider"].value = String(Math.max(30, Math.min(120, tapeMinutes)));
  elements["side-capacity"].textContent = `${formatTime(capacityMs)} / SIDE`;
  elements["snap-toggle"].classList.toggle("active", project.snappingEnabled);
  elements["snap-toggle"].setAttribute("aria-pressed", String(project.snappingEnabled));
  const sourceLabel = normalizeDubbingSource(audioRouting.dubbingSource) === "music" ? "music" : "control";
  elements["preload-dubbing"].textContent = `Preload ${sourceLabel} · side ${side}`;
  elements["start-dubbing"].textContent = `Start recording · side ${side}`;
}

function switchProjectSide(side) {
  const nextSide = side === "B" ? "B" : "A";
  if (project.activeSide === nextSide) return;
  setPreviewPlaying(false);
  const selectedBufferClipIds = [...selectedClipIds].filter((clipId) => findProjectClip(project, clipId)?.zone === "buffer");
  const selectedBufferClipId = selectedBufferClipIds.includes(selectedClipId) ? selectedClipId : selectedBufferClipIds[0];
  activateProjectSide(project, nextSide);
  const fallbackClipId = project.clips[0]?.id || project.bufferClips[0]?.id || null;
  setSelectionState(selectedBufferClipIds.length ? selectedBufferClipIds : [fallbackClipId].filter(Boolean), selectedBufferClipId || fallbackClipId);
  playheadMs = 0;
  history.undo.length = 0;
  history.redo.length = 0;
  audioEngine.reset();
  renderTimeline();
  saveProject(true);
  updateHistoryButtons();
  notify(`Switched to side ${nextSide}`);
}

function setTapeLength(value) {
  const minutes = Math.max(1, Math.min(240, Number(value) || 60));
  project.tapeLengthMinutes = Math.round(minutes * 10) / 10;
  renderTimeline();
  saveProject(true);
}

function renderTimeline() {
  recomputeTimeline(project);
  normalizeSelectionState();
  const pps = pixelsPerSecond();
  const capacityMs = cassetteSideCapacityMs(project);
  const bufferEndMs = project.bufferClips.reduce(
    (maximum, clip) => Math.max(maximum, clip.bufferXMs + clipDuration(clip)),
    0
  );
  const visualEndMs = Math.max(project.totalDurationMs, capacityMs, bufferEndMs);
  const width = Math.max(elements["timeline-scroll"].clientWidth - 64, visualEndMs / 1000 * pps + 160);
  const timelineHeight = elements["timeline-content"].clientHeight || elements["timeline-scroll"].clientHeight || 500;
  project.editorTrackHeight = Math.round(Math.max(150, Math.min(timelineHeight - 112, project.editorTrackHeight || 174)));
  elements["timeline-content"].style.width = `${width + 64}px`;
  elements["timeline-content"].style.backgroundSize = `${Math.max(40, pps * 10)}px 100%`;
  elements["timeline-content"].style.setProperty("--track-zone-height", `${project.editorTrackHeight}px`);

  const tickSeconds = zoom < 2 ? 30 : zoom < 5 ? 15 : zoom < 9 ? 10 : 5;
  const ticks = [];
  for (let second = 0; second <= visualEndMs / 1000 + tickSeconds * 2; second += tickSeconds) {
    ticks.push(`<i class="ruler-tick major" style="left:${64 + second * pps}px"><span>${formatTime(second * 1000)}</span></i>`);
    if (tickSeconds >= 10) {
      ticks.push(`<i class="ruler-tick" style="left:${64 + (second + tickSeconds / 2) * pps}px"></i>`);
    }
  }
  elements.ruler.innerHTML = ticks.join("");

  elements["clip-lane"].innerHTML = project.clips.map((clip) => {
    const left = clip.startMs / 1000 * pps;
    const widthPx = Math.max(15, (clip.endMs - clip.startMs) / 1000 * pps);
    const fadeIn = Math.min(100, clip.fadeInMs / Math.max(1, clip.endMs - clip.startMs) * 100);
    const fadeOut = Math.max(0, 100 - clip.fadeOutMs / Math.max(1, clip.endMs - clip.startMs) * 100);
    return `
      <article class="clip ${selectedClipIds.has(clip.id) ? "selected" : ""}"
        data-clip-id="${clip.id}" data-zone="timeline" data-lane="0" tabindex="0"
        aria-label="${escapeAttribute(`${clip.title} by ${clip.artist}`)}"
        style="left:${left}px; width:${widthPx}px; top:32px">
        <div class="clip-head">
          <span>${escapeHtml(clip.title)} — ${escapeHtml(clip.artist)}</span>
          <b>${formatTime(clip.endMs - clip.startMs)} · →${escapeHtml(clip.nextTrackId)}</b>
        </div>
        <div class="waveform">${waveformBars(clip.neteaseId)}</div>
        <svg class="fade-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polyline points="0,100 ${fadeIn},10 ${fadeOut},10 100,100"></polyline>
        </svg>
        <div class="gain-envelope" data-gain-envelope="${clip.id}" title="Double-click to add a gain point">
          <svg class="gain-line" viewBox="0 0 100 100" preserveAspectRatio="none">
            <polyline points="${gainPolyline(clip)}"></polyline>
          </svg>
          ${gainPointMarkup(clip)}
        </div>
      </article>
    `;
  }).join("");

  const bufferHeight = Math.max(100, timelineHeight - project.editorTrackHeight - 5);
  elements["buffer-canvas"].innerHTML = project.bufferClips.map((clip) => {
    const left = clip.bufferXMs / 1000 * pps;
    const widthPx = Math.max(90, clipDuration(clip) / 1000 * pps);
    const top = Math.max(8, Math.min(bufferHeight - 84, clip.bufferY));
    clip.bufferY = top;
    return `
      <article class="clip buffer-clip ${selectedClipIds.has(clip.id) ? "selected" : ""}"
        data-clip-id="${clip.id}" data-zone="buffer" tabindex="0"
        aria-label="${escapeAttribute(`${clip.title} by ${clip.artist}, in buffer`)}"
        style="left:${left}px; width:${widthPx}px; top:${top}px">
        <div class="clip-head">
          <span>${escapeHtml(clip.title)} — ${escapeHtml(clip.artist)}</span>
          <b>${formatTime(clipDuration(clip))}</b>
        </div>
        <div class="waveform">${waveformBars(clip.neteaseId)}</div>
      </article>
    `;
  }).join("");
  elements["buffer-empty"].hidden = project.bufferClips.length > 0;

  const overflowLeft = 64 + capacityMs / 1000 * pps;
  elements["tape-overflow"].classList.toggle("visible", project.totalDurationMs > capacityMs);
  elements["tape-overflow"].style.left = `${overflowLeft}px`;
  elements["tape-overflow"].style.right = "0";
  elements["tape-overflow-label"].textContent = `EXCEEDS SIDE ${project.activeSide} | C${Math.round(project.tapeLengthMinutes)}`;

  elements["total-time"].textContent = formatTime(project.totalDurationMs, true);
  updateCassetteControls();
  updatePlayhead();
  renderInspector();
  updateClipboardButtons();
}

function renderInspector() {
  const selected = selectedProjectClip();
  const clip = selected?.clip || null;
  const selectionCount = selectedClipIds.size;
  if (inspectorPreview && inspectorPreview.clip.id !== clip?.id) stopInspectorPreview();
  elements["inspector-fields"].classList.toggle("disabled", !clip);
  elements["inspector-preview"].classList.toggle("disabled", !clip);
  elements["inspector-title"].textContent = selectionCount > 1
    ? `${selectionCount} clips selected`
    : clip ? `${clip.title} · ${clip.artist}` : "Select a clip";
  elements["inspector-zone"].textContent = selected
    ? selected.zone === "buffer" ? "BUFFER · SHARED A/B" : `TIMELINE · SIDE ${project.activeSide}`
    : "NO SELECTION";
  elements["inspector-preview-title"].textContent = clip ? `${clip.title} — ${clip.artist}` : "Choose a timeline or buffer clip";
  elements["inspector-preview-toggle"].disabled = !clip;
  elements["inspector-preview-seek"].disabled = !clip;
  elements["inspector-preview-duration"].textContent = clip ? formatTime(clipDuration(clip), true) : "0:00.0";
  const coverUrl = clip?.coverUrl || "";
  elements["inspector-artwork"].classList.toggle("has-cover", Boolean(coverUrl));
  elements["inspector-artwork-fallback"].textContent = artworkInitials(clip);
  if (coverUrl) {
    elements["inspector-cover"].src = coverUrl;
    elements["inspector-cover"].alt = `${clip.title} cover`;
  } else {
    elements["inspector-cover"].removeAttribute("src");
    elements["inspector-cover"].alt = "";
  }
  if (!inspectorPreview) setInspectorPreviewButton(false);
  elements["move-left"].disabled = !clip;
  elements["move-right"].disabled = !clip;
  elements["delete-clip"].disabled = !clip;
  elements["split-clip"].disabled = !clip || selectionCount > 1 || selected?.zone === "buffer";
  elements["inspector-fields"].querySelectorAll("input").forEach((input) => {
    if (!clip) {
      input.value = "";
      return;
    }
    const field = input.dataset.field;
    if (field === "nextTrackId") input.value = selected.zone === "buffer" ? "BUFFER" : clip.nextTrackId || "0";
    else input.value = field === "gainDb" ? clip[field] : (clip[field] / 1000).toFixed(1);
  });
}

function updatePlayhead() {
  const position = 64 + playheadMs / 1000 * pixelsPerSecond();
  elements.playhead.style.left = `${position}px`;
  elements["current-time"].textContent = formatTime(playheadMs, true);
  const active = activeClipsAt(project, Math.min(playheadMs, Math.max(0, project.totalDurationMs - 1)));
  elements["now-playing"].textContent = active.length
    ? active.map(({ clip }) => `${clip.title} — ${clip.artist}`).join("  ×  ")
    : "Ready to preview";
  updatePlaybackView();
}

function addTrack(track, placement = null) {
  pushHistory();
  const clip = createClip(track);
  if (placement?.zone === "buffer") {
    clip.bufferXMs = Math.max(0, Math.round(placement.xMs || 0));
    clip.bufferY = Math.max(0, Math.round(placement.y || 0));
    project.bufferClips.push(clip);
  } else {
    clip.startMs = placement?.xMs == null ? project.totalDurationMs : Math.max(0, Math.round(placement.xMs));
    clip.lane = 0;
    project.clips.push(clip);
    if (placement?.xMs != null) overwriteLaneWithClip(project, clip.id);
  }
  setSelectionState([clip.id], clip.id);
  recomputeTimeline(project);
  renderTimeline();
  saveProject(true);
  notify(`${track.title} added to ${placement?.zone === "buffer" ? "the buffer" : project.name}`);
}

function setPreviewPlaying(next) {
  if (previewPlaying === next) return;
  previewPlaying = next;
  elements["play-toggle"].classList.toggle("playing", previewPlaying);
  if (previewPlaying) {
    stopInspectorPreview();
    previewLastTick = performance.now();
    audioEngine.sync(playheadMs, true);
    previewAnimationFrame = requestAnimationFrame(previewTick);
  } else {
    cancelAnimationFrame(previewAnimationFrame);
    audioEngine.pauseAll();
  }
}

function previewTick(now) {
  if (!previewPlaying) return;
  const delta = now - previewLastTick;
  previewLastTick = now;
  playheadMs += delta;
  if (playheadMs >= project.totalDurationMs) {
    playheadMs = project.totalDurationMs;
    setPreviewPlaying(false);
    updatePlayhead();
    return;
  }
  if (now - previewLastAudioSyncAt >= 120) {
    previewLastAudioSyncAt = now;
    audioEngine.sync(playheadMs, true);
  }
  updatePlayhead();
  previewAnimationFrame = requestAnimationFrame(previewTick);
}

function setTapePlaying(next, { keepMediaWarm = true } = {}) {
  if (tapePlaying === next) {
    if (!nativeAudio && !next && !keepMediaWarm) tapeAudioEngine.pauseAll();
    return;
  }
  const now = performance.now();
  advanceTapeClock(tapeClock, now, tapePlaying);
  tapePlaying = next;
  updatePlaybackView();
  if (tapePlaying) {
    if (!nativeAudio) tapeAudioEngine.applyFrame(tapeClock?.frame, { shouldPlay: true });
    tapeAnimationFrame = requestAnimationFrame(tapeTick);
  } else {
    cancelAnimationFrame(tapeAnimationFrame);
    if (!nativeAudio) {
      if (keepMediaWarm) tapeAudioEngine.silenceAll();
      else tapeAudioEngine.pauseAll();
    }
  }
}

function tapeTick(now) {
  if (!tapePlaying || !tapeClock) return;
  advanceTapeClock(tapeClock, now, true);
  if (!nativeAudio) tapeAudioEngine.updateGains(tapeClock.timelineMs);
  updatePlaybackView();
  tapeAnimationFrame = requestAnimationFrame(tapeTick);
}

async function searchNetease(query) {
  const requestedMode = libraryMode;
  const requestId = ++librarySearchRequestId;
  const local = DEMO_LIBRARY.filter((track) =>
    `${track.title} ${track.artist} ${track.neteaseId}`.toLowerCase().includes(query.toLowerCase())
  );
  if (!query.trim()) {
    library = requestedMode === "tracks" ? [...DEMO_LIBRARY] : [];
    expandedCollectionKey = null;
    elements["provider-note"].textContent = `Search NetEase Cloud Music ${requestedMode}`;
    renderLibrary();
    return;
  }
  if (!requireProviderConnection(`search NetEase ${requestedMode}`)) {
    elements["provider-note"].textContent = "Connect in Settings to search the music API";
    return;
  }

  try {
    elements["provider-note"].textContent = `Searching ${requestedMode}…`;
    const response = await fetch(`/api/netease/search?q=${encodeURIComponent(query)}&kind=${requestedMode}`);
    if (!response.ok) throw new Error("Provider unavailable");
    const data = await response.json();
    if (requestedMode !== libraryMode || requestId !== librarySearchRequestId) return;
    if (requestedMode === "tracks") {
      library = (data.result?.songs || []).map((song) => ({
        neteaseId: String(song.id),
        title: song.name,
        artist: (song.ar || song.artists || []).map((artist) => artist.name).join(", "),
        album: song.al?.name || song.album?.name || "Unknown album",
        coverUrl: song.al?.picUrl || song.album?.picUrl || "",
        durationMs: song.dt || song.duration || 180_000
      }));
    } else if (requestedMode === "albums") {
      library = (data.result?.albums || []).map((album) => ({
        id: String(album.id),
        kind: "album",
        title: album.name || "Untitled album",
        subtitle: (album.artists || [album.artist]).filter(Boolean).map((artist) => artist.name).join(", ") || "Unknown artist",
        coverUrl: album.picUrl || album.blurPicUrl || "",
        trackCount: Number(album.size) || 0
      }));
    } else {
      library = (data.result?.playlists || []).map((playlist) => ({
        id: String(playlist.id),
        kind: "playlist",
        title: playlist.name || "Untitled playlist",
        subtitle: playlist.creator?.nickname || "NetEase playlist",
        coverUrl: playlist.coverImgUrl || "",
        trackCount: Number(playlist.trackCount) || 0
      }));
    }
    expandedCollectionKey = null;
    elements["provider-status"].textContent = "NetEase-compatible provider";
    elements["provider-note"].textContent = `${library.length} ${requestedMode} from configured provider`;
  } catch {
    if (requestedMode !== libraryMode || requestId !== librarySearchRequestId) return;
    library = requestedMode === "tracks" ? local : [];
    expandedCollectionKey = null;
    elements["provider-status"].textContent = "Local demo provider";
    elements["provider-note"].textContent = requestedMode === "tracks" && local.length
      ? "Showing matching demo tracks"
      : `No ${requestedMode} available from the provider`;
  }
  renderLibrary();
}

function setLibraryMode(mode) {
  if (!['tracks', 'albums', 'playlists'].includes(mode) || mode === libraryMode) return;
  libraryMode = mode;
  expandedCollectionKey = null;
  document.querySelectorAll("[data-library-mode]").forEach((button) => {
    const active = button.dataset.libraryMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  elements["library-title"].textContent = mode[0].toUpperCase() + mode.slice(1);
  elements["search-input"].placeholder = mode === "tracks"
    ? "Search tracks or paste song ID"
    : `Search ${mode}`;
  searchNetease(elements["search-input"].value);
}

async function toggleLibraryCollection(index) {
  const item = library[index];
  if (!item?.kind) return;
  if (!requireProviderConnection(`load this ${item.kind}`)) return;
  const key = `${item.kind}:${item.id}`;
  if (expandedCollectionKey === key) {
    expandedCollectionKey = null;
    renderLibrary();
    return;
  }
  expandedCollectionKey = key;
  if (!collectionDetails.has(key)) collectionDetails.set(key, { loading: true });
  renderLibrary();
  if (!collectionDetails.get(key)?.loading) return;
  try {
    const response = await fetch(`/api/netease/collection?kind=${encodeURIComponent(item.kind)}&id=${encodeURIComponent(item.id)}`);
    const detail = await response.json();
    if (!response.ok || !Array.isArray(detail.tracks)) throw new Error(detail.message || "Tracks are unavailable");
    collectionDetails.set(key, detail);
  } catch (error) {
    collectionDetails.set(key, { error: error.message || "Tracks are unavailable" });
  }
  if (expandedCollectionKey === key) renderLibrary();
}

function setCollectionImportTapeLength(value) {
  const minutes = Math.max(1, Math.min(240, Math.round(Number(value) || 60)));
  elements["collection-tape-custom"].value = String(minutes);
  elements["collection-tape-slider"].value = String(Math.max(30, Math.min(120, minutes)));
  elements["collection-tape-label"].textContent = `C${minutes}`;
  document.querySelectorAll("[data-import-tape-length]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.importTapeLength) === minutes);
  });
  updateCollectionImportPlan();
}

function updateCollectionImportPlan() {
  if (!pendingCollectionImport) return;
  const minutes = Number(elements["collection-tape-custom"].value) || 60;
  const plan = collectionImportPlan(pendingCollectionImport.tracks, minutes);
  const capacity = formatTime(plan.sideCapacityMs);
  elements["collection-side-a-plan"].textContent = `${formatTime(plan.sideADurationMs)} / ${capacity}`;
  elements["collection-side-b-plan"].textContent = `${formatTime(plan.sideBDurationMs)} / ${capacity}`;
  if (plan.cutTrackIndex >= 0) {
    const cutTrack = pendingCollectionImport.tracks[plan.cutTrackIndex];
    elements["collection-cut-plan"].textContent = `Before ${cutTrack.title} · starts side B`;
  } else {
    elements["collection-cut-plan"].textContent = "Side B not required";
  }
  const warning = elements["collection-import-warning"];
  warning.classList.toggle("overflow", plan.overflowMs > 0);
  if (plan.overflowMs > 0) {
    warning.textContent = `Too long by ${formatTime(plan.overflowMs)} with whole songs preserved. The excess on side B will be shown in gray.`;
  } else if (plan.cutTrackIndex >= 0) {
    warning.textContent = `Fits this tape. “${pendingCollectionImport.tracks[plan.cutTrackIndex].title}” moves intact to side B, leaving ${formatTime(plan.sideAGapMs)} blank at the end of side A.`;
  } else {
    warning.textContent = "Fits entirely on side A. No song will be split.";
  }
}

function openCollectionImport(key) {
  const detail = collectionDetails.get(key);
  if (!detail?.collection || !detail.tracks?.length) return;
  pendingCollectionImport = detail;
  const collection = detail.collection;
  elements["collection-import-title"].textContent = collection.title;
  elements["collection-import-meta"].textContent = `${collection.subtitle} · ${detail.tracks.length} tracks · ${formatTime(detail.tracks.reduce((sum, track) => sum + track.durationMs, 0))}`;
  elements["collection-import-initials"].textContent = artworkInitials(collection);
  const artwork = elements["collection-import-cover"].parentElement;
  artwork.classList.toggle("has-cover", Boolean(collection.coverUrl));
  if (collection.coverUrl) elements["collection-import-cover"].src = collection.coverUrl;
  else elements["collection-import-cover"].removeAttribute("src");
  setCollectionImportTapeLength(project.tapeLengthMinutes || 60);
  elements["collection-import-dialog"].showModal();
}

function importPendingCollection() {
  if (!pendingCollectionImport?.tracks?.length) return;
  saveProject(true);
  const minutes = Number(elements["collection-tape-custom"].value) || 60;
  project = createCollectionMixtape(
    pendingCollectionImport.collection.title,
    pendingCollectionImport.tracks,
    minutes
  );
  mixtapeStore.items.push(structuredClone(project));
  insertMixtapeInLayout(mixtapeStore, project.id);
  mixtapeStore.activeId = project.id;
  setSelectionState([project.clips[0]?.id || project.bufferClips[0]?.id].filter(Boolean));
  playheadMs = 0;
  history.undo.length = 0;
  history.redo.length = 0;
  elements["project-name"].value = project.name;
  audioEngine.reset();
  renderTimeline();
  saveProject(true);
  updateHistoryButtons();
  notify(`${pendingCollectionImport.collection.title} imported as a new C${Math.round(minutes)} mixtape`);
}

async function refreshProviderStatus() {
  try {
    const response = await fetch("/api/netease/status");
    if (!response.ok) throw new Error("Provider unavailable");
    providerState = await response.json();
    elements["provider-status"].textContent = providerState.authenticated
      ? "API Enhanced · connected"
      : "API Enhanced · sign in for audio";
    elements["netease-account-action"].textContent = providerState.authenticated ? "Log out" : "Connect";
    elements["netease-account-action"].classList.toggle("primary", !providerState.authenticated);
    elements["netease-account-action"].classList.toggle("subtle", providerState.authenticated);
    document.querySelector(".connection-dot")?.classList.toggle("disconnected", !providerState.authenticated);
    elements["provider-note"].textContent = providerState.authenticated
      ? "Live search and account-authorized playback"
      : "Live search enabled · connect for playable URLs";
  } catch {
    providerState = { available: false, authenticated: false };
    elements["provider-status"].textContent = "Provider offline";
    elements["netease-account-action"].textContent = "Retry";
    elements["netease-account-action"].classList.add("primary");
    elements["netease-account-action"].classList.remove("subtle");
    document.querySelector(".connection-dot")?.classList.add("disconnected");
  }
}

function closeLoginDialog() {
  clearTimeout(loginPollTimer);
  loginPollTimer = 0;
  if (elements["login-dialog"].open) elements["login-dialog"].close();
}

function closeProviderWarning() {
  if (elements["provider-warning-dialog"].open) elements["provider-warning-dialog"].close();
}

function setLoginStatus(message, error = false) {
  elements["login-status"].querySelector("span").textContent = message;
  elements["login-status"].classList.toggle("error", error);
}

async function startQrLogin() {
  clearTimeout(loginPollTimer);
  elements["login-dialog"].showModal();
  elements["login-qr"].removeAttribute("src");
  elements["login-qr"].closest(".qr-shell").classList.remove("ready");
  elements["qr-placeholder"].querySelector("strong").textContent = "Creating secure login…";
  setLoginStatus("Requesting a QR code");
  try {
    const response = await fetch("/api/netease/login/qr/start");
    const data = await response.json();
    if (!response.ok || !data.key || !data.qrimg) {
      throw new Error(data.detail || "QR login is unavailable");
    }
    elements["login-qr"].src = data.qrimg;
    elements["login-qr"].closest(".qr-shell").classList.add("ready");
    setLoginStatus("Waiting for scan");
    pollQrLogin(data.key);
  } catch (error) {
    elements["qr-placeholder"].querySelector("strong").textContent = "Could not create QR code";
    setLoginStatus(error.message, true);
  }
}

async function pollQrLogin(key) {
  if (!elements["login-dialog"].open) return;
  try {
    const response = await fetch(`/api/netease/login/qr/check?key=${encodeURIComponent(key)}`);
    const data = await response.json();
    if (data.code === 803 && data.authenticated) {
      setLoginStatus("Connected successfully");
      audioEngine.reset();
      tapeAudioEngine.reset();
      nativeAudio?.command({ type: "resetTracks" }).catch(() => {});
      if (tapeClock) tapeAudioEngine.applyFrame(tapeClock.frame, { shouldPlay: tapePlaying, forceSeek: true });
      await refreshProviderStatus();
      notify("NetEase Cloud Music connected");
      loginPollTimer = setTimeout(closeLoginDialog, 700);
      return;
    }
    if (data.code === 800) {
      setLoginStatus("QR code expired · close and try again", true);
      return;
    }
    setLoginStatus(data.code === 802 ? "Scanned · confirm on your phone" : "Waiting for scan");
  } catch {
    setLoginStatus("Connection interrupted · retrying", true);
  }
  loginPollTimer = setTimeout(() => pollQrLogin(key), 2_000);
}

async function providerAction() {
  if (providerState.authenticated) {
    await logoutProvider();
    return;
  }
  if (!providerState.available) await refreshProviderStatus();
  if (providerState.authenticated) return;
  if (providerState.available) startQrLogin();
}

async function logoutProvider() {
  try {
    const response = await fetch("/api/netease/logout");
    if (!response.ok) throw new Error("The saved login could not be removed");
    audioEngine.reset();
    tapeAudioEngine.reset();
    nativeAudio?.command({ type: "resetTracks" }).catch(() => {});
    setTapePlaying(false);
    await refreshProviderStatus();
    notify("NetEase account disconnected");
  } catch (error) {
    notify(error.message || "NetEase logout failed");
  }
}

function exportWav() {
  if (!project.clips.length) {
    notify("Add at least one track before exporting");
    return;
  }
  elements["export-wav"].disabled = true;
  elements["export-wav"].textContent = "Encoding…";
  setTimeout(() => {
    try {
      generatedSamples = generateProjectSignal(project);
      const baseName = project.name.replace(/[^\w\u4e00-\u9fff-]+/g, "-").replace(/^-|-$/g, "") || "cassette-control";
      const filename = `${baseName}-side-${project.activeSide.toLowerCase()}.wav`;
      downloadSignalWav(generatedSamples, filename);
      notify(`WAV exported · ${formatTime(PREROLL_MS, true)} lock-in leader · robust dual-channel`);
    } finally {
      elements["export-wav"].disabled = false;
      elements["export-wav"].innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 20h14"/></svg> Dub control WAV`;
    }
  }, 40);
}

function showDecodedFrame(frame, drift = 0) {
  elements["frame-track"].textContent = frame.trackId;
  elements["frame-time"].textContent = formatTime(frame.timelineMs, true);
  elements["frame-confidence"].textContent = `${Math.round(frame.confidence * 100)}%`;
  elements["frame-drift"].textContent = `${drift >= 0 ? "+" : ""}${(drift / 1000).toFixed(2)}s`;
}

async function applyDecodedFrame(frame) {
  const now = performance.now();
  if (nativeAudio) {
    const reconciled = reconcileTapeDisplayClock(tapeClock, frame, now, {
      playing: tapePlaying,
      force: !tapePlaying || !frameRequestsPlayback(frame)
    });
    tapeClock = reconciled.clock;
    showDecodedFrame(frame, reconciled.timelineDriftMs);
    tapeHasPosition = true;
    if (tapeCarrierLive) setTapePlaying(frameRequestsPlayback(frame));
    updatePlaybackView(true);
    return;
  }
  advanceTapeClock(tapeClock, now, tapePlaying);
  const drift = frame.timelineMs - (tapeClock?.timelineMs ?? frame.timelineMs);
  showDecodedFrame(frame, drift);
  const decision = tapeSynchronizer.accept(frame, {
    playheadMs: tapeClock?.timelineMs ?? 0,
    currentTrackId: tapeClock?.frame?.trackId,
    expectedNextTrackId: tapeClock?.frame?.nextTrackId,
    totalDurationMs: Number.MAX_SAFE_INTEGER
  });
  if (decision.reason === "confirming") {
    if (!nativeAudio) {
      tapeAudioEngine.load(frame.trackId);
      if (frame.nextTrackId !== "0") tapeAudioEngine.load(frame.nextTrackId);
    }
    return;
  }

  const continuous = decision.reason === "continuous" && tapeClock;
  const gainTargetDelayMs = Math.max(0, frame.gainTargetTimelineMs - frame.timelineMs);
  const playbackTimelineMs = continuous ? tapeClock.timelineMs : decision.targetMs;
  const effectiveFrame = {
    ...frame,
    timelineMs: playbackTimelineMs,
    sourceMs: continuous ? tapeClock.sourceMs : frame.sourceMs,
    gainStartTimelineMs: playbackTimelineMs,
    gainTargetTimelineMs: playbackTimelineMs + gainTargetDelayMs
  };
  tapeClock = {
    frame: effectiveFrame,
    timelineMs: effectiveFrame.timelineMs,
    sourceMs: effectiveFrame.sourceMs,
    updatedAt: now
  };
  tapeHasPosition = true;
  if (!nativeAudio) {
    await tapeAudioEngine.applyFrame(effectiveFrame, {
      shouldPlay: tapePlaying,
      forceSeek: decision.relocate
    });
  }
  if (tapeCarrierLive) setTapePlaying(frameRequestsPlayback(effectiveFrame));
  updatePlaybackView(true);
  if (decision.reason === "resynchronize") {
    notify("Tape relocation detected · standalone player resynchronized");
  }
}

function inputDeviceSelectors() {
  return [elements["input-device"], elements["playback-input-device"], elements["settings-input-device"]];
}

function outputDeviceSelectors() {
  return [
    [elements["settings-playback-output"], "playbackOutputId"],
    [elements["settings-dubbing-output"], "dubbingOutputId"],
    [elements["dub-output-device"], "dubbingOutputId"],
    [elements["eq-calibration-output"], "dubbingOutputId"]
  ];
}

function musicQualitySelectors() {
  return [elements["settings-music-quality"], elements["dub-music-quality"]];
}

function updateMusicQualityUi() {
  const options = AUDIO_QUALITY_OPTIONS.map((option) =>
    `<option value="${option.value}">${escapeHtml(option.label)}</option>`
  ).join("");
  musicQualitySelectors().forEach((select) => {
    if (!select.options.length) select.innerHTML = options;
    select.value = audioRouting.musicQuality;
  });
}

function changeMusicQuality(event) {
  discardPreparedDubbing();
  audioRouting.musicQuality = normalizeAudioQuality(event.currentTarget.value);
  saveAudioRouting();
  musicQualitySelectors().forEach((select) => { select.value = audioRouting.musicQuality; });
  setPreviewPlaying(false);
  audioEngine.reset();
  tapeAudioEngine.reset();
  clearDubbingPreflight();
  nativeAudio?.command({ type: "setQuality", quality: audioRouting.musicQuality }).catch(() => {});
  updateMusicMonitorAvailability();
  notify(`Music quality set to ${audioQualityLabel(audioRouting.musicQuality)}`);
}

function setDubbingStatus(message, { processing = false } = {}) {
  const status = elements["dubbing-status"];
  status.classList.toggle("processing", processing);
  status.querySelector("b").textContent = message;
}

function setDubbingProgress(positionMs = 0, durationMs = preparedDubbing?.durationMs || 0) {
  const progress = durationMs ? Math.max(0, Math.min(1, positionMs / durationMs)) : 0;
  elements["dubbing-progress-fill"].style.width = `${(progress * 100).toFixed(2)}%`;
  elements["dubbing-progress"].setAttribute("aria-valuenow", String(Math.round(progress * 100)));
  elements["dubbing-time"].textContent = durationMs
    ? `${formatTime(positionMs, true)} / ${formatTime(durationMs, true)}`
    : "0:00.0";
}

function dubbingPreparationKey(source = normalizeDubbingSource(audioRouting.dubbingSource)) {
  return JSON.stringify({
    projectId: project.id,
    side: project.activeSide,
    updatedAt: project.updatedAt,
    totalDurationMs: project.totalDurationMs,
    clipCount: project.clips.length,
    source,
    outputId: audioRouting.dubbingOutputId,
    quality: audioRouting.musicQuality,
    monitoring: elements["dub-music-monitor"].checked
  });
}

function updateDubbingActionUi() {
  const active = Boolean(dubbingSession);
  const ready = Boolean(preparedDubbing) && !active;
  const locked = active || ready || dubbingPreloadPending;
  elements["preload-dubbing"].hidden = ready || active;
  elements["preload-dubbing"].disabled = dubbingPreloadPending;
  elements["start-dubbing"].hidden = !ready;
  elements["start-dubbing"].disabled = !ready;
  elements["stop-dubbing"].hidden = !active && !ready;
  elements["stop-dubbing"].disabled = !active && !ready;
  elements["stop-dubbing"].textContent = active ? "Stop" : "Cancel";
  elements["dub-output-device"].disabled = locked;
  elements["dub-actual-music"].disabled = locked;
  elements["dub-music-quality"].disabled = locked;
  elements["refresh-outputs"].disabled = locked;
  updateMusicMonitorAvailability();
}

function disposeDubbingResources(prepared) {
  if (!prepared) return;
  if (prepared.source === "music") {
    prepared.engine.reset();
    prepared.monitorEngine?.reset();
    return;
  }
  prepared.audio.pause();
  prepared.audio.onended = null;
  prepared.audio.onerror = null;
  prepared.audio.removeAttribute("src");
  URL.revokeObjectURL(prepared.url);
}

function discardPreparedDubbing({ clearAccess = true } = {}) {
  dubbingPreloadGeneration += 1;
  dubbingPreloadPending = false;
  const prepared = preparedDubbing;
  preparedDubbing = null;
  disposeDubbingResources(prepared);
  if (clearAccess) clearDubbingPreflight();
  setDubbingProgress();
  updateDubbingActionUi();
}

function stopOrCancelDubbing() {
  if (dubbingSession) {
    stopDubbing();
    return;
  }
  if (preparedDubbing && !elements["dubbing-cancel-dialog"].open) {
    elements["dubbing-cancel-dialog"].showModal();
  }
}

function clearDubbingPreflight() {
  elements["dubbing-preflight"].hidden = true;
  elements["dubbing-preflight-list"].innerHTML = "";
  elements["dubbing-preflight-summary"].textContent = "";
}

function renderDubbingPreflight(summary) {
  const availableCount = summary.tracks.length - summary.unavailable.length;
  elements["dubbing-preflight"].hidden = false;
  elements["dubbing-preflight-title"].textContent = summary.unavailable.length
    ? "Music access check failed"
    : "Music access check passed";
  elements["dubbing-preflight-summary"].textContent = `${availableCount}/${summary.tracks.length} available`;
  elements["dubbing-preflight-list"].innerHTML = summary.tracks.map((track) => {
    const unavailable = !track.available;
    const downgraded = Boolean(track.resolution?.fallback);
    const state = unavailable ? "unavailable" : downgraded ? "downgraded" : "available";
    const result = unavailable ? "UNAVAILABLE" : t(audioQualityLabel(track.resolution?.actual));
    const detail = unavailable
      ? track.message || "This account cannot stream this track"
      : downgraded
        ? `${t(audioQualityLabel(track.resolution.requested))} unavailable; using ${t(audioQualityLabel(track.resolution.actual))}`
        : `Authorized at ${t(audioQualityLabel(track.resolution?.actual))}`;
    return `<li class="${state}"><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(result)}</span><small>${escapeHtml(detail)}</small></li>`;
  }).join("");
}

async function preflightMusicDubbing() {
  const tracks = uniqueStreamingTracks(timelineOrder(project));
  if (!tracks.length) {
    clearDubbingPreflight();
    return { tracks: [], unavailable: [], downgraded: [] };
  }
  elements["dubbing-preflight"].hidden = false;
  elements["dubbing-preflight-title"].textContent = "Checking music access";
  elements["dubbing-preflight-summary"].textContent = `0/${tracks.length}`;
  elements["dubbing-preflight-list"].innerHTML = "";
  const summary = await preflightTrackAccess(tracks, async (track) => {
    const response = await fetch(
      `/api/netease/url?id=${encodeURIComponent(track.id)}&level=${encodeURIComponent(audioRouting.musicQuality)}`
    );
    const payload = await response.json();
    if (!response.ok) return {
      available: false,
      message: payload.message || payload.detail || "No playable URL is available for this account"
    };
    const playable = payload.data?.some?.((item) => item?.url) || payload.url;
    return playable
      ? { available: true, resolution: payload.resolution || {
          requested: audioRouting.musicQuality,
          actual: audioRouting.musicQuality === "best" ? "standard" : audioRouting.musicQuality,
          fallback: false
        } }
      : { available: false, message: "NetEase returned no playable URL" };
  }, {
    concurrency: 3,
    onProgress({ completed, total }) {
      elements["dubbing-preflight-summary"].textContent = `${completed}/${total}`;
      setDubbingStatus(`Checking music access - ${completed}/${total}`, { processing: true });
    }
  });
  renderDubbingPreflight(summary);
  if (summary.unavailable.length) {
    const count = summary.unavailable.length;
    throw new Error(`${count} ${count === 1 ? "track is" : "tracks are"} unavailable for this account. Preloading did not complete.`);
  }
  return summary;
}

function preflightQualitySummary(summary) {
  const qualities = [...new Set(summary.tracks
    .filter((track) => track.available && track.resolution?.actual)
    .map((track) => t(audioQualityLabel(track.resolution.actual))))];
  return qualities.length ? qualities.join(" / ") : t(audioQualityLabel(audioRouting.musicQuality));
}

function updateMusicMonitorAvailability() {
  const routingSupported = typeof HTMLMediaElement.prototype.setSinkId === "function";
  const shared = !routingSupported || outputsAreShared();
  const dubbingMusic = normalizeDubbingSource(audioRouting.dubbingSource) === "music";
  const monitor = elements["dub-music-monitor"];
  const row = monitor.closest(".switch-row");
  const locked = Boolean(dubbingSession || preparedDubbing || dubbingPreloadPending);
  row.hidden = false;
  monitor.disabled = shared || locked;
  row.classList.toggle("disabled", shared || locked);
  if (shared && monitor.checked) {
    monitor.checked = false;
    setPreviewPlaying(false);
  }
  const explanation = !routingSupported
    ? "Music monitoring is unavailable because this browser cannot route playback and dubbing to separate outputs."
    : shared
      ? "Music monitoring is unavailable because playback and dubbing use the same output. Choose separate outputs in Audio settings to prevent music from being recorded over the control signal."
    : "Playback and dubbing are routed separately; music monitoring is available.";
  elements["dubbing-warning"].textContent = dubbingMusic && !shared
    ? `Actual music goes to the deck at ${audioQualityLabel(audioRouting.musicQuality)}; monitoring is routed separately to the playback output.`
    : explanation;
  elements["routing-notice"].textContent = explanation;
  elements["routing-notice"].classList.toggle("separate", !shared);
}

function updateDubbingModeUi() {
  const dubbingMusic = normalizeDubbingSource(audioRouting.dubbingSource) === "music";
  elements["dub-actual-music"].checked = dubbingMusic;
  elements["dubbing-title"].textContent = dubbingMusic
    ? "Send actual music to cassette deck"
    : "Send control signal to cassette deck";
  elements["dubbing-description"].textContent = dubbingMusic
    ? "The edited songs, trims, gaps, and gain automation are played directly to the selected deck output."
    : "The encoded signal is routed to the selected output. Digital music monitoring stays on the computer's normal playback output.";
  elements["dubbing-output-label"].textContent = dubbingMusic ? "MUSIC DUBBING OUTPUT" : "CONTROL SIGNAL OUTPUT";
  elements["dub-monitor-description"].textContent = dubbingMusic
    ? "Duplicate the music to the normal playback or headphone output"
    : "Play digital music while the control signal is being dubbed";
  updateCassetteControls();
  updateMusicMonitorAvailability();
  if (!dubbingMusic && !preparedDubbing) clearDubbingPreflight();
  updateDubbingActionUi();
  if (!dubbingSession && !preparedDubbing && !dubbingPreloadPending) {
    setDubbingStatus(dubbingMusic ? "Ready - preload actual music" : "Ready - preload the control signal");
  }
}

function selectedDiagnostic() {
  return diagnosticStore.reports.find((report) => report.id === diagnosticStore.activeId) || null;
}

function eqResponsePath(values) {
  if (!Array.isArray(values) || values.length < 2) return "";
  return values.map((value, index) => {
    const x = 55 + index / (values.length - 1) * 645;
    const y = 87.5 - Math.max(-12, Math.min(12, value)) / 24 * 135;
    return `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}

function formatDiagnosticFrequency(value) {
  if (!Number.isFinite(value)) return "—";
  return value >= 1_000 ? `${Number((value / 1_000).toFixed(1))} kHz` : `${Math.round(value)} Hz`;
}

function renderDiagnostics() {
  if (diagnosticStore.activeId && !selectedDiagnostic()) diagnosticStore.activeId = "";
  const options = [
    '<option value="">No saved report</option>',
    ...diagnosticStore.reports.map((report) =>
      `<option value="${escapeHtml(report.id)}">${escapeHtml(report.name)}</option>`
    )
  ].join("");
  elements["eq-profile-select"].innerHTML = options;
  elements["eq-profile-select"].value = diagnosticStore.activeId;
  const report = selectedDiagnostic();
  elements["delete-eq-profile"].disabled = !report;
  elements["eq-response-left"].setAttribute("d", eqResponsePath(report?.channels.left.responseDb));
  elements["eq-response-right"].setAttribute("d", eqResponsePath(report?.channels.right.responseDb));
  elements["diagnostic-metrics"].hidden = !report;
  renderEqMarkerDiagnostics(report?.markers || []);
  if (report) {
    elements["eq-response-title"].textContent = `${report.name}: measured left and right frequency response`;
    const balance = report.channelBalanceDb;
    elements["diagnostic-balance-value"].textContent = Math.abs(balance) < 0.15
      ? "Matched"
      : `${balance > 0 ? "L" : "R"} +${Math.abs(balance).toFixed(1)} dB`;
    elements["diagnostic-balance-detail"].textContent = `Average mismatch ${Math.abs(balance).toFixed(1)} dB from 400 Hz–4 kHz`;
    const leftBandwidth = report.channels.left.bandwidth6Db;
    const rightBandwidth = report.channels.right.bandwidth6Db;
    elements["diagnostic-bandwidth-value"].textContent =
      `L ${formatDiagnosticFrequency(leftBandwidth.lowHz)}–${formatDiagnosticFrequency(leftBandwidth.highHz)}`;
    elements["diagnostic-bandwidth-detail"].textContent =
      `R ${formatDiagnosticFrequency(rightBandwidth.lowHz)}–${formatDiagnosticFrequency(rightBandwidth.highHz)} · within −6 dB`;
    const thd = (value) => Number.isFinite(value) ? `${value.toFixed(value < 10 ? 1 : 0)}%` : "—";
    elements["diagnostic-thd-value"].textContent = `L ${thd(report.thdPercent.left)} · R ${thd(report.thdPercent.right)}`;
    elements["diagnostic-thd-detail"].textContent = "Approximate THD at the 1 kHz marker";
    elements["diagnostic-snr-value"].textContent =
      `L ${report.channels.left.snrDb.toFixed(0)} dB · R ${report.channels.right.snrDb.toFixed(0)} dB`;
    elements["diagnostic-snr-detail"].textContent = "Midband level relative to recorded silence";
    const isolation = (value) => Number.isFinite(value) ? `${Math.max(0, value).toFixed(0)} dB` : "—";
    elements["diagnostic-crosstalk-value"].textContent =
      `L→R ${isolation(report.crosstalkDb.leftToRight)} · R→L ${isolation(report.crosstalkDb.rightToLeft)}`;
    elements["diagnostic-crosstalk-detail"].textContent = "Stereo isolation during the single-channel sweeps";
    elements["diagnostic-speed-value"].textContent = `${report.speedErrorPercent >= 0 ? "+" : ""}${report.speedErrorPercent.toFixed(2)}%`;
    elements["diagnostic-speed-detail"].textContent = `${(report.speedRatio * 100).toFixed(2)}% of nominal tape speed`;
  }
}

function selectDiagnostic(reportId) {
  diagnosticStore.activeId = String(reportId || "");
  saveDiagnostics();
  renderDiagnostics();
}

function setEqCalibrationStatus(status, detail, progress = 0, badge = "READY") {
  elements["eq-calibration-status"].textContent = status;
  elements["eq-calibration-detail"].textContent = detail;
  elements["eq-calibration-progress"].style.width = `${progress}%`;
  elements["eq-calibration-progress"].parentElement.setAttribute("aria-valuenow", String(progress));
  elements["eq-calibration-badge"].textContent = badge;
}

function setEqCalibrationBusy(busy) {
  elements["eq-record-signal"].disabled = busy;
  elements["eq-profile-name"].disabled = busy;
  elements["eq-calibration-output"].disabled = busy;
  elements["eq-calibration-file"].disabled = busy;
  elements["eq-file-port"].classList.toggle("disabled", busy);
  elements["eq-cancel-calibration"].hidden = !busy;
}

function setEqAnalysisStage(activeStage = "", completedStages = []) {
  elements["eq-analysis-stages"].querySelectorAll("[data-stage]").forEach((stage) => {
    stage.classList.toggle("active", stage.dataset.stage === activeStage);
    stage.classList.toggle("complete", completedStages.includes(stage.dataset.stage));
  });
}

function renderEqMarkerDiagnostics(markers = []) {
  elements["eq-marker-diagnostics"].hidden = markers.length === 0;
  elements["eq-marker-diagnostics"].innerHTML = markers.map((marker) => marker.inferred
    ? `<span class="inferred"><b>${marker.nominalHz / 1_000} kHz · INFERRED</b>${marker.timeSeconds.toFixed(2)} s · timing fallback</span>`
    : `<span><b>${marker.nominalHz / 1_000} kHz · ${marker.frequencyHz.toFixed(0)} Hz</b>${marker.timeSeconds.toFixed(2)} s · ${marker.snrDb.toFixed(0)} dB SNR</span>`
  ).join("");
}

function stopEqCalibration({ resetStatus = true } = {}) {
  eqAnalysisGeneration += 1;
  if (eqCalibrationAudio) {
    eqCalibrationAudio.audio.pause();
    URL.revokeObjectURL(eqCalibrationAudio.url);
    cancelAnimationFrame(eqCalibrationAudio.animationFrame);
    eqCalibrationAudio = null;
  }
  setEqCalibrationBusy(false);
  setEqAnalysisStage();
  if (resetStatus) setEqCalibrationStatus("Calibration stopped", "Choose another recording to run calibration again.");
}

async function recordEqCalibrationSignal() {
  stopEqCalibration({ resetStatus: false });
  const signal = generateEqCalibrationSignal();
  const blob = new Blob([encodeWav({ left: signal.left, right: signal.right })], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.preload = "auto";
  try {
    await routeMediaElement(audio, audioRouting.dubbingOutputId, { strict: true });
    eqCalibrationAudio = { audio, url, animationFrame: 0, durationMs: signal.manifest.durationMs };
    setEqCalibrationBusy(true);
    const update = () => {
      if (!eqCalibrationAudio) return;
      const progress = Math.min(100, audio.currentTime * 1_000 / signal.manifest.durationMs * 100);
      setEqCalibrationStatus("Recording identified calibration signal", "Keep the deck recording until the signal finishes.", progress, "RECORDING");
      eqCalibrationAudio.animationFrame = requestAnimationFrame(update);
    };
    audio.addEventListener("ended", () => {
      URL.revokeObjectURL(url);
      cancelAnimationFrame(eqCalibrationAudio?.animationFrame || 0);
      eqCalibrationAudio = null;
      setEqCalibrationBusy(false);
      setEqCalibrationStatus("Test signal recorded", "Capture its complete cassette playback in a recording app, then upload the audio file below.", 100, "UPLOAD");
    }, { once: true });
    await audio.play();
    update();
  } catch (error) {
    URL.revokeObjectURL(url);
    eqCalibrationAudio = null;
    setEqCalibrationBusy(false);
    setEqCalibrationStatus("Could not play calibration signal", error.message, 0, "ERROR");
  }
}

async function analyzeEqCalibrationFile(file) {
  stopEqCalibration({ resetStatus: false });
  if (!file) return;
  if (file.size > 512 * 1024 * 1024) {
    setEqCalibrationStatus("File is too large", "Choose an audio recording smaller than 512 MB.", 0, "ERROR");
    return;
  }
  const generation = eqAnalysisGeneration;
  elements["eq-file-details"].hidden = false;
  elements["eq-file-name"].textContent = file.name;
  elements["eq-file-format"].textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB · reading…`;
  setEqCalibrationBusy(true);
  renderEqMarkerDiagnostics();
  setEqAnalysisStage("decode");
  setEqCalibrationStatus("Decoding uploaded recording", "Reading the complete audio file…", 8, "DECODING");
  let context = null;
  try {
    const bytes = await file.arrayBuffer();
    if (generation !== eqAnalysisGeneration) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("This system cannot decode audio files.");
    context = new AudioContextClass({ sampleRate: 48_000 });
    const buffer = await context.decodeAudioData(bytes);
    if (generation !== eqAnalysisGeneration) return;
    if (buffer.numberOfChannels < 2) {
      throw new Error("This is a mono recording. Upload a stereo recording so the left and right sweeps can be measured separately.");
    }
    const duration = buffer.duration;
    elements["eq-file-format"].textContent =
      `${duration.toFixed(1)} s · ${buffer.numberOfChannels} ch · ${(buffer.sampleRate / 1_000).toFixed(1)} kHz`;
    setEqAnalysisStage("markers", ["decode"]);
    setEqCalibrationStatus("Detecting identification markers", "Searching the complete recording for the start, separator, and end tones…", 25, "ANALYZING");
    const measurement = await analyzeRecordedEqCalibration({
      left: new Float32Array(buffer.getChannelData(0)),
      right: new Float32Array(buffer.getChannelData(1)),
      sampleRate: buffer.sampleRate
    }, ({ stage, progress, detail }) => {
      if (generation !== eqAnalysisGeneration) throw new Error("Calibration analysis cancelled");
      const completed = stage === "markers" ? ["decode"] : ["decode", "markers"];
      setEqAnalysisStage(stage === "complete" ? "report" : stage, completed);
      setEqCalibrationStatus("Analyzing uploaded recording", detail, progress, "ANALYZING");
    });
    if (generation !== eqAnalysisGeneration) return;
    const report = deriveCassetteDiagnostic(measurement, {
      id: `diagnostic-${Date.now().toString(36)}`,
      name: elements["eq-profile-name"].value,
      sourceFile: file.name
    });
    renderEqMarkerDiagnostics(measurement.markers);
    diagnosticStore.reports.push(report);
    diagnosticStore.activeId = report.id;
    saveDiagnostics();
    renderDiagnostics();
    setEqAnalysisStage("", ["decode", "markers", "sweeps", "report"]);
    setEqCalibrationStatus(
      "Diagnostic report saved",
      `${report.name} · channel mismatch ${Math.abs(report.channelBalanceDb).toFixed(1)} dB · tape speed ${(report.speedRatio * 100).toFixed(2)}%.`,
      100,
      "SAVED"
    );
    notify(`Diagnostic report saved · ${report.name}`);
  } catch (error) {
    if (generation === eqAnalysisGeneration && error.message !== "Calibration analysis cancelled") {
      setEqAnalysisStage();
      setEqCalibrationStatus("Could not analyze recording", error.message, 0, "ERROR");
    }
  } finally {
    await context?.close().catch(() => {});
    if (generation === eqAnalysisGeneration) setEqCalibrationBusy(false);
    elements["eq-calibration-file"].value = "";
  }
}

function waitForMediaMetadata(media, timeoutMs = 15_000) {
  if (media.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timeout;
    const finish = (error = null) => {
      clearTimeout(timeout);
      media.removeEventListener("loadedmetadata", loaded);
      media.removeEventListener("error", failed);
      if (error) reject(error);
      else resolve();
    };
    const loaded = () => finish();
    const failed = () => finish(new Error("The selected song could not be loaded"));
    timeout = setTimeout(() => finish(new Error("Timed out while loading music metadata")), timeoutMs);
    media.addEventListener("loadedmetadata", loaded, { once: true });
    media.addEventListener("error", failed, { once: true });
    media.load();
  });
}

function changeDubbingSource(event) {
  if (event.currentTarget.checked && !requireProviderConnection("enable music dubbing")) {
    event.currentTarget.checked = false;
    return;
  }
  discardPreparedDubbing();
  audioRouting.dubbingSource = event.currentTarget.checked ? "music" : "control";
  saveAudioRouting();
  updateDubbingModeUi();
}

function updateNoiseGateUi() {
  const threshold = normalizeNoiseGateDb(audioRouting.inputNoiseGateDb);
  audioRouting.inputNoiseGateDb = threshold;
  elements["settings-noise-gate"].value = String(threshold);
  elements["settings-noise-gate-value"].textContent = `${threshold} dBFS`;
  const position = Math.max(0, Math.min(100, (threshold + 90) / 70 * 100));
  document.querySelectorAll(".input-meter-track").forEach((track) => {
    track.style.setProperty("--noise-gate-position", `${position}%`);
  });
}

function changeInputNoiseGate(event) {
  audioRouting.inputNoiseGateDb = normalizeNoiseGateDb(event.currentTarget.value);
  saveAudioRouting();
  updateNoiseGateUi();
  nativeAudio?.command({ type: "setNoiseGate", noiseGateDb: audioRouting.inputNoiseGateDb }).catch(() => {});
}

function changeLanguage(event) {
  audioRouting.language = normalizeLocale(event.currentTarget.value);
  setLocale(audioRouting.language);
  elements["settings-language"].value = audioRouting.language;
  saveAudioRouting();
  notify(t("Language changed"));
}

async function refreshOutputDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    outputDeviceSelectors().forEach(([select]) => {
      select.innerHTML = '<option value="">System default output</option>';
      select.disabled = true;
    });
    updateMusicMonitorAvailability();
    return;
  }
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audiooutput");
    webAudioOutputs = devices;
    const webOptions = [
      '<option value="">System default output</option>',
      ...devices.map((device, index) => `<option value="${escapeHtml(device.deviceId)}">${escapeHtml(device.label || `Output device ${index + 1}`)}</option>`)
    ].join("");
    outputDeviceSelectors().forEach(([select, setting]) => {
      const sourceDevices = nativeAudio && setting === "playbackOutputId" ? nativeAudioDevices.outputs : devices;
      select.innerHTML = nativeAudio && setting === "playbackOutputId"
        ? [
            '<option value="">System default output (native WASAPI)</option>',
            ...sourceDevices.map((device, index) => `<option value="${escapeHtml(device.id)}">${escapeHtml(device.label || `Output device ${index + 1}`)}</option>`)
          ].join("")
        : webOptions;
      const selectedId = audioRouting[setting];
      if (sourceDevices.some((device) => (device.deviceId || device.id) === selectedId)) select.value = selectedId;
      select.disabled = false;
    });
    updateMusicMonitorAvailability();
  } catch {
    outputDeviceSelectors().forEach(([select]) => {
      select.innerHTML = '<option value="">System default output</option>';
    });
  }
}

async function changePlaybackOutput(event) {
  audioRouting.playbackOutputId = event.currentTarget.value;
  saveAudioRouting();
  if (nativeAudio) {
    await nativeAudio.command({ type: "setOutput", outputDeviceId: audioRouting.playbackOutputId });
    const webOutputId = matchingWebPlaybackOutputId(audioRouting.playbackOutputId);
    await Promise.all([
      audioEngine.setOutputDevice(webOutputId),
      tapeAudioEngine.setOutputDevice(webOutputId)
    ]);
  } else {
    await Promise.all([
      audioEngine.setOutputDevice(audioRouting.playbackOutputId),
      tapeAudioEngine.setOutputDevice(audioRouting.playbackOutputId)
    ]);
  }
  updateMusicMonitorAvailability();
  notify("Music playback output updated");
}

function changeDubbingOutput(event) {
  discardPreparedDubbing();
  audioRouting.dubbingOutputId = event.currentTarget.value;
  saveAudioRouting();
  outputDeviceSelectors().forEach(([select, setting]) => {
    if (setting === "dubbingOutputId" && [...select.options].some((option) => option.value === audioRouting.dubbingOutputId)) {
      select.value = audioRouting.dubbingOutputId;
    }
  });
  updateMusicMonitorAvailability();
  notify("Dubbing output updated");
}

async function openAudioSettings() {
  await Promise.all([refreshProviderStatus(), refreshInputDevices(), refreshOutputDevices()]);
  updateMusicQualityUi();
  updateNoiseGateUi();
  updateMusicMonitorAvailability();
  elements["settings-language"].value = audioRouting.language;
  elements["settings-dialog"].showModal();
}

function updateDubbingProgress(now = performance.now()) {
  if (!dubbingSession) return;
  const { source, durationMs } = dubbingSession;
  const positionMs = source === "music"
    ? Math.min(durationMs, Math.max(0, now - dubbingSession.startedAt))
    : Math.min(durationMs, dubbingSession.audio.currentTime * 1000);
  setDubbingProgress(positionMs, durationMs);
  if (source === "music") {
    if (!dubbingSession.syncing && now - dubbingSession.lastAudioSyncAt >= 120) {
      dubbingSession.lastAudioSyncAt = now;
      dubbingSession.syncing = true;
      const activeSession = dubbingSession;
      Promise.all([
        activeSession.engine.sync(positionMs, true),
        activeSession.monitorEngine?.sync(positionMs, true)
      ])
        .catch((error) => {
          if (dubbingSession !== activeSession) return;
          stopDubbing();
          notify(error.message || "Music dubbing playback stopped");
        })
        .finally(() => {
          activeSession.syncing = false;
        });
    }
    playheadMs = positionMs;
    updatePlayhead();
    setDubbingStatus(
      `Dubbing actual music · side ${project.activeSide}` +
      ` · ${dubbingSession.qualitySummary}` +
      (dubbingSession.monitorEngine ? " · monitor on" : "")
    );
    if (positionMs >= durationMs) {
      stopDubbing({ completed: true });
      return;
    }
    dubbingSession.animationFrame = requestAnimationFrame(updateDubbingProgress);
    return;
  }
  const monitoring = elements["dub-music-monitor"].checked;
  if (monitoring && positionMs >= PREROLL_MS) {
    const target = Math.min(project.totalDurationMs, Math.max(0, positionMs - PREROLL_MS));
    if (!previewPlaying) {
      playheadMs = target;
      setPreviewPlaying(true);
    } else if (Math.abs(playheadMs - target) > 350) {
      playheadMs = target;
    }
    setDubbingStatus(`Dubbing side ${project.activeSide} - music monitor on`);
  } else {
    if (previewPlaying) setPreviewPlaying(false);
    setDubbingStatus(positionMs < PREROLL_MS
      ? `Locking carrier - music starts in ${Math.max(0, (PREROLL_MS - positionMs) / 1000).toFixed(1)}s`
      : `Dubbing side ${project.activeSide} - control signal only`);
  }
  dubbingSession.animationFrame = requestAnimationFrame(updateDubbingProgress);
}

function stopDubbing({ completed = false, discardPreparation = false } = {}) {
  if (!dubbingSession) {
    if (discardPreparation) discardPreparedDubbing();
    return;
  }
  const session = dubbingSession;
  dubbingSession = null;
  cancelAnimationFrame(session.animationFrame);
  if (session.source === "music") {
    session.engine.pauseAll();
    session.monitorEngine?.pauseAll();
  } else {
    session.audio.pause();
    session.audio.onended = null;
    session.audio.onerror = null;
    session.audio.currentTime = 0;
  }
  setPreviewPlaying(false);
  playheadMs = 0;
  updatePlayhead();
  updateDubbingActionUi();
  setDubbingStatus(completed
    ? "Recording complete - preloaded audio is ready again"
    : "Recording stopped - preloaded audio is ready");
  if (completed) {
    setDubbingProgress(session.durationMs, session.durationMs);
  } else {
    setDubbingProgress(0, session.durationMs);
  }
  if (discardPreparation) discardPreparedDubbing();
}

async function prepareMusicDubbing(accessSummary) {
  const monitoring = elements["dub-music-monitor"].checked;
  const engine = new AudioPlaybackEngine({
    outputDeviceId: () => audioRouting.dubbingOutputId,
    strictOutput: true,
    waitForMetadata: true,
    strictPlayback: true
  });
  const monitorEngine = monitoring
    ? new AudioPlaybackEngine({
        outputDeviceId: () => browserPlaybackOutputId(),
        strictOutput: true,
        waitForMetadata: true,
        strictPlayback: true
      })
    : null;
  const engines = [engine, monitorEngine].filter(Boolean);
  try {
    await preloadAudioEntries(timelineOrder(project), engines, {
      concurrency: 3,
      onProgress({ completed, total }) {
        setDubbingStatus(`Preloading music - ${completed}/${total}`, { processing: true });
        const progress = total ? completed / total : 0;
        elements["dubbing-progress-fill"].style.width = `${(progress * 100).toFixed(2)}%`;
        elements["dubbing-progress"].setAttribute("aria-valuenow", String(Math.round(progress * 100)));
      }
    });
    await Promise.all(engines.map((item) => item.sync(0, false)));
  } catch (error) {
    engines.forEach((item) => item.reset());
    throw error;
  }
  return {
    source: "music",
    engine,
    monitorEngine,
    durationMs: project.totalDurationMs,
    qualitySummary: preflightQualitySummary(accessSummary)
  };
}

function encodeDubbingProject(projectSnapshot) {
  if (typeof Worker !== "function") {
    const samples = generateProjectSignal(projectSnapshot);
    return Promise.resolve({
      wav: encodeWav(samples),
      durationMs: samples.left.length / SIGNAL.sampleRate * 1_000
    });
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./dubbing-encoder-worker.js", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event) => {
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data);
    }, { once: true });
    worker.addEventListener("error", (event) => {
      worker.terminate();
      reject(new Error(event.message || "Control-signal encoder failed"));
    }, { once: true });
    worker.postMessage({ project: projectSnapshot });
  });
}

async function prepareControlDubbing() {
  const cacheKey = `${project.id}:${project.activeSide}:${project.updatedAt}:${project.totalDurationMs}:${project.clips.length}`;
  if (!dubbingEncodeCache || dubbingEncodeCache.key !== cacheKey) {
    const encoded = await encodeDubbingProject(structuredClone(project));
    dubbingEncodeCache = {
      key: cacheKey,
      wav: encoded.wav,
      durationMs: encoded.durationMs
    };
  }
  const blob = new Blob([dubbingEncodeCache.wav], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.preload = "auto";
  try {
    await routeMediaElement(audio, audioRouting.dubbingOutputId, { strict: true });
    await waitForMediaMetadata(audio);
    audio.currentTime = 0;
    return {
      source: "control",
      audio,
      url,
      durationMs: dubbingEncodeCache.durationMs
    };
  } catch (error) {
    audio.pause();
    audio.removeAttribute("src");
    URL.revokeObjectURL(url);
    throw error;
  }
}

async function preloadDubbing() {
  if (dubbingSession || preparedDubbing || dubbingPreloadPending) return;
  if (!project.clips.length) {
    notify(`Add at least one track to side ${project.activeSide} before dubbing`);
    return;
  }
  const source = normalizeDubbingSource(audioRouting.dubbingSource);
  const needsMusicApi = source === "music" || elements["dub-music-monitor"].checked;
  if (needsMusicApi && !requireProviderConnection(source === "music" ? "dub actual music" : "monitor music while dubbing")) return;
  const generation = ++dubbingPreloadGeneration;
  dubbingPreloadPending = true;
  setPreviewPlaying(false);
  setDubbingProgress();
  updateDubbingActionUi();
  setDubbingStatus(source === "music" ? "Checking music access..." : "Processing control signal...", { processing: true });
  let prepared = null;
  try {
    syncActiveSide(project);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (source === "music") {
      const accessSummary = await preflightMusicDubbing();
      prepared = await prepareMusicDubbing(accessSummary);
    } else {
      prepared = await prepareControlDubbing();
    }
    if (generation !== dubbingPreloadGeneration) {
      disposeDubbingResources(prepared);
      return;
    }
    prepared.key = dubbingPreparationKey(source);
    preparedDubbing = prepared;
    prepared = null;
    dubbingPreloadPending = false;
    setDubbingProgress(0, preparedDubbing.durationMs);
    setDubbingStatus(source === "music"
      ? "Music preloaded - ready to start recording"
      : "Control signal preloaded - ready to start recording");
    updateDubbingActionUi();
  } catch (error) {
    disposeDubbingResources(prepared);
    if (generation !== dubbingPreloadGeneration) return;
    dubbingPreloadPending = false;
    updateDubbingActionUi();
    setDubbingStatus(error.message || "Could not preload dubbing audio");
    notify(error.message || "Could not preload dubbing audio");
  }
}

async function startPreparedDubbing() {
  if (dubbingSession || !preparedDubbing || dubbingPreloadPending) return;
  const prepared = preparedDubbing;
  playheadMs = 0;
  updatePlayhead();
  try {
    if (prepared.source === "music") {
      const startedAt = performance.now();
      dubbingSession = {
        ...prepared,
        startedAt,
        lastAudioSyncAt: startedAt,
        syncing: false,
        animationFrame: 0
      };
      updateDubbingActionUi();
      await Promise.all([
        prepared.engine.sync(0, true),
        prepared.monitorEngine?.sync(0, true)
      ]);
      setDubbingStatus(
        `Dubbing actual music · ${prepared.qualitySummary}` +
        (prepared.monitorEngine ? " · monitor on" : "")
      );
      updateDubbingProgress(startedAt);
      return;
    }
    prepared.audio.currentTime = 0;
    prepared.audio.onended = () => stopDubbing({ completed: true });
    prepared.audio.onerror = () => {
      stopDubbing();
      notify("The encoded signal could not be sent to the selected output");
    };
    dubbingSession = { ...prepared, animationFrame: 0 };
    updateDubbingActionUi();
    await prepared.audio.play();
    setDubbingStatus(`Locking carrier - ${Math.round(PREROLL_MS / 1000)}s leader`);
    updateDubbingProgress();
  } catch (error) {
    if (dubbingSession) stopDubbing();
    setDubbingStatus(error.message || "Could not start recording");
    notify(error.message || "Could not start recording");
  }
}

async function refreshInputDevices(preferredId = audioRouting.inputDeviceId) {
  if (nativeAudio) {
    const devices = nativeAudioDevices.inputs;
    const options = [
      '<option value="">System default input (native WASAPI)</option>',
      ...devices.map((device, index) => `<option value="${escapeHtml(device.id)}">${escapeHtml(device.label || `Input device ${index + 1}`)}</option>`)
    ].join("");
    inputDeviceSelectors().forEach((select) => {
      select.innerHTML = options;
      if (devices.some((device) => device.id === preferredId)) select.value = preferredId;
      select.disabled = false;
    });
    return;
  }
  if (!navigator.mediaDevices?.enumerateDevices) {
    inputDeviceSelectors().forEach((select) => {
      select.innerHTML = '<option value="">Audio input unavailable</option>';
      select.disabled = true;
    });
    return;
  }
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === "audioinput");
    const previous = preferredId;
    const options = [
      '<option value="">System default input</option>',
      ...devices.map((device, index) => `
          <option value="${escapeHtml(device.deviceId)}">${escapeHtml(device.label || `Input device ${index + 1}`)}</option>
        `)
    ].join("");
    inputDeviceSelectors().forEach((select) => {
      select.innerHTML = options;
      if (devices.some((device) => device.deviceId === previous)) select.value = previous;
      select.disabled = false;
    });
  } catch {
    inputDeviceSelectors().forEach((select) => {
      select.innerHTML = '<option value="">System default input</option>';
    });
  }
}

async function changeInputDevice(event) {
  const deviceId = event.currentTarget.value;
  audioRouting.inputDeviceId = deviceId;
  saveAudioRouting();
  inputDeviceSelectors().forEach((select) => {
    if ([...select.options].some((option) => option.value === deviceId)) select.value = deviceId;
  });
  if (!liveInput) return;
  stopLiveInput();
  await startLiveInput();
}

function stopLiveInput() {
  if (liveInput) liveInput.stop();
  liveInput = null;
  lastInputMetrics = null;
  lastInputMetricsAt = 0;
  elements["start-input"].textContent = "Start audio input";
  elements["input-badge"].textContent = "OFFLINE";
  elements["input-badge"].classList.remove("live", "signal");
  setInputMeter(null);
  setCarrierUi(false, "Input disconnected");
  tapeInputState = "idle";
  tapeCarrierLive = false;
  tapeHasPosition = false;
  tapeSynchronizer.reset();
  setTapePlaying(false, { keepMediaWarm: false });
  tapeClock = null;
  if (!nativeAudio) tapeAudioEngine.reset();
  updatePlaybackView();
}

async function startLiveInput() {
  if (liveInput) {
    stopLiveInput();
    return;
  }

  try {
    setTapePlaying(false, { keepMediaWarm: false });
    tapeInputState = "arming";
    tapeCarrierLive = false;
    tapeHasPosition = false;
    tapeSynchronizer.reset();
    updatePlaybackView();
    const selectedDeviceId = elements["input-device"].value;
    if (nativeAudio) {
      await nativeAudio.command({
        type: "startInput",
        inputDeviceId: selectedDeviceId,
        outputDeviceId: audioRouting.playbackOutputId,
        quality: audioRouting.musicQuality,
        noiseGateDb: audioRouting.inputNoiseGateDb
      });
      liveInput = {
        native: true,
        stop() { nativeAudio.command({ type: "stopInput" }).catch(() => {}); }
      };
      tapeInputState = "armed";
      elements["start-input"].textContent = "Stop audio input";
      elements["input-badge"].textContent = "ARMED";
      elements["input-badge"].classList.add("live");
      const activeLabel = elements["input-device"].selectedOptions[0]?.textContent || "selected input";
      elements["decoder-detail"].textContent = `Native WASAPI listening to ${activeLabel}`;
      notify(`Native audio input armed · ${activeLabel}`);
      updatePlaybackView();
      return;
    }
    const audioConstraints = {
      channelCount: { ideal: 2 },
      sampleRate: SIGNAL.sampleRate,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    };
    if (selectedDeviceId) audioConstraints.deviceId = { exact: selectedDeviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    const activeDeviceId = stream.getAudioTracks()[0]?.getSettings().deviceId || selectedDeviceId;
    await refreshInputDevices(activeDeviceId);
    const context = new AudioContext({ sampleRate: SIGNAL.sampleRate, latencyHint: "interactive" });
    const source = context.createMediaStreamSource(stream);
    source.channelCountMode = "max";
    const decoderWorker = new Worker(new URL("./input-decoder-worker.js", import.meta.url), { type: "module" });
    const meterWorker = new Worker(new URL("./input-meter-worker.js", import.meta.url), { type: "module" });
    const gate = new CarrierGate({ stopMs: CARRIER_STOP_MS, releaseMs: 700 });
    let lastValidFrameAt = 0;
    let evaluateCarrier = () => {};

    const forwardSamples = ({ left, right = null }) => {
      const meterLeft = left.slice(0);
      const meterRight = right?.slice(0) || null;
      meterWorker.postMessage({
        type: "samples",
        left: meterLeft,
        right: meterRight,
        sampleRate: context.sampleRate,
        noiseGateDb: audioRouting.inputNoiseGateDb
      }, meterRight ? [meterLeft, meterRight] : [meterLeft]);
      decoderWorker.postMessage({
        type: "samples",
        left,
        right,
        sampleRate: context.sampleRate
      }, right ? [left, right] : [left]);
    };

    meterWorker.addEventListener("message", (event) => {
      if (event.data?.type === "metrics") {
        lastInputMetrics = smoothInputMetrics(lastInputMetrics, event.data.metrics);
        lastInputMetricsAt = performance.now();
        evaluateCarrier(lastInputMetricsAt);
      }
    });

    decoderWorker.addEventListener("message", (event) => {
      if (event.data?.type === "frame") {
        lastValidFrameAt = performance.now();
        applyDecodedFrame(event.data.frame).catch((error) => {
          console.error("Could not apply decoded cassette frame", error);
        });
      }
    });

    let captureNode;
    let silentNode = null;
    try {
      await context.audioWorklet.addModule("/src/input-capture-worklet.js");
      captureNode = new AudioWorkletNode(context, "cassette-input-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: "max",
        outputChannelCount: [1],
        processorOptions: { blockSize: 2_048 }
      });
      captureNode.port.addEventListener("message", (event) => forwardSamples(event.data));
      captureNode.port.start();
      source.connect(captureNode).connect(context.destination);
    } catch {
      captureNode = context.createScriptProcessor(2_048, 2, 1);
      silentNode = context.createGain();
      silentNode.gain.value = 0;
      captureNode.onaudioprocess = (event) => {
        const left = Float32Array.from(event.inputBuffer.getChannelData(0));
        const right = event.inputBuffer.numberOfChannels > 1
          ? Float32Array.from(event.inputBuffer.getChannelData(1))
          : null;
        forwardSamples({ left: left.buffer, right: right?.buffer || null });
      };
      source.connect(captureNode);
      captureNode.connect(silentNode).connect(context.destination);
    }
    await context.resume();

    evaluateCarrier = (now = performance.now()) => {
      if (!liveInput) return;
      const metricsAge = now - lastInputMetricsAt;
      const carrierMetrics = metricsAge < INPUT_METRICS_FRESH_MS ? lastInputMetrics : null;
      const displayMetrics = metricsAge < INPUT_DISPLAY_HOLD_MS ? lastInputMetrics : null;
      const detected = Boolean(carrierMetrics?.pilotDetected);
      const validFrame = lastValidFrameAt > 0 && now - lastValidFrameAt < SIGNAL.frameDurationMs * 3;
      const result = gate.update({
        pilotDetected: detected,
        validFrame,
        detectedAt: lastInputMetricsAt,
        now
      });
      const detailMetrics = carrierMetrics || displayMetrics;
      const detail = result.live && validFrame
        ? `Valid frame · ${tapeClock?.frame?.inputChannel || "best"} channel`
        : !detailMetrics?.inputDetected
        ? detailMetrics
          ? `Input below ${detailMetrics.noiseGateDb} dBFS noise gate`
          : "No audio signal is reaching this input"
        : detected
          ? `Pilot ${Math.round(detailMetrics.pilotHz)} Hz on ${detailMetrics.pilotChannel} · waiting for a valid frame`
          : result.live
            ? "Carrier held through a brief detector gap"
            : `Audio present · no 6 kHz pilot (best ${Math.round(detailMetrics.pilotHz)} Hz at ${detailMetrics.pilotDb.toFixed(0)} dBFS)`;
      setCarrierUi(result.live, detail, result.live || detected);
      setInputMeter(displayMetrics);
      if (result.changed) {
        if (result.live) {
          tapeCarrierLive = true;
          setTapePlaying(frameRequestsPlayback(tapeClock?.frame));
        } else {
          tapeCarrierLive = false;
          lastValidFrameAt = 0;
          setTapePlaying(false);
          tapeSynchronizer.reset();
        }
      }
    };

    liveInput = {
      stream,
      context,
      captureNode,
      decoderWorker,
      meterWorker,
      stop() {
        captureNode.disconnect();
        silentNode?.disconnect();
        decoderWorker.terminate();
        meterWorker.terminate();
        source.disconnect();
        stream.getTracks().forEach((track) => track.stop());
        context.close();
      }
    };
    tapeInputState = "armed";
    elements["start-input"].textContent = "Stop audio input";
    elements["input-badge"].textContent = "ARMED";
    elements["input-badge"].classList.add("live");
    const activeLabel = elements["input-device"].selectedOptions[0]?.textContent || "selected input";
    elements["decoder-detail"].textContent = `Listening to ${activeLabel}`;
    notify(`Audio input armed · ${activeLabel}`);
    updatePlaybackView();
  } catch (error) {
    tapeInputState = "error";
    tapeCarrierLive = false;
    elements["input-badge"].textContent = "ERROR";
    elements["input-badge"].classList.remove("live", "signal");
    setInputMeter(null);
    tapeSynchronizer.reset();
    setTapePlaying(false, { keepMediaWarm: false });
    updatePlaybackView();
    notify(`Could not start audio input: ${error.message}`);
  }
}

function setCarrierUi(live, detail, pilotDetected = false) {
  elements["signal-visual"].classList.toggle("live", live);
  elements["signal-visual"].classList.toggle("pilot", pilotDetected);
  elements["carrier-label"].textContent = live
    ? "CARRIER LOCKED"
    : pilotDetected
      ? "PILOT DETECTED"
      : "NO CARRIER";
  elements["decoder-detail"].textContent = detail;
}

function handleNativeAudioEvent(event) {
  if (!event?.type) return;
  if (event.type === "devices") {
    nativeAudioDevices = {
      inputs: Array.isArray(event.inputs) ? event.inputs : [],
      outputs: Array.isArray(event.outputs) ? event.outputs : []
    };
    refreshInputDevices(audioRouting.inputDeviceId);
    refreshOutputDevices();
    return;
  }
  if (event.type === "metrics") {
    lastInputMetrics = event;
    lastInputMetricsAt = performance.now();
    setInputMeter(event);
    return;
  }
  if (event.type === "frame") {
    applyDecodedFrame(event).catch((error) => console.error("Could not display native cassette frame", error));
    return;
  }
  if (event.type === "carrier") {
    tapeCarrierLive = Boolean(event.live);
    const detail = event.live
      ? "Native WASAPI carrier and frame locked"
      : event.pilotDetected
        ? "6 kHz pilot present · waiting for a valid frame"
        : "Native input has no valid carrier";
    setCarrierUi(tapeCarrierLive, detail, Boolean(event.pilotDetected));
    if (tapeCarrierLive) setTapePlaying(frameRequestsPlayback(tapeClock?.frame));
    else {
      setTapePlaying(false);
      tapeSynchronizer.reset();
    }
    return;
  }
  if (event.type === "inputStarted") {
    elements["decoder-detail"].textContent = `Native WASAPI · ${event.label}`;
    return;
  }
  if (event.type === "trackReady") {
    const actual = normalizeAudioQuality(event.quality);
    playbackStreamQuality.set(String(event.trackId), {
      requested: audioRouting.musicQuality,
      actual,
      fallback: audioRouting.musicQuality !== "best" && actual !== audioRouting.musicQuality
    });
    updatePlaybackView(true);
    return;
  }
  if (event.type === "error") {
    console.error("Native audio host", event);
    if (event.scope === "native-host" || event.scope === "track") notify(event.message || "Native audio host error");
  }
}

function setInputMeter(metrics) {
  const detected = Boolean(metrics?.inputDetected);
  const levelDb = metrics?.levelDb ?? -120;
  const noiseGateDb = metrics?.noiseGateDb ?? audioRouting.inputNoiseGateDb;
  const meterPercent = metrics ? Math.max(1, Math.min(100, (levelDb + 90) / 90 * 100)) : 0;
  elements["input-level-fill"].style.width = `${meterPercent}%`;
  elements["playback-input-level-fill"].style.width = `${meterPercent}%`;
  elements["input-level-label"].textContent = metrics
    ? `${levelDb.toFixed(1)} dBFS · GATE ${noiseGateDb}`
    : "NO SIGNAL";
  elements["playback-input-level-label"].textContent = elements["input-level-label"].textContent;
  const channelText = metrics?.channels
    ?.map((channel) => `${channel.label} ${channel.levelDb.toFixed(1)} dBFS`)
    .join(" · ") || "L — · R —";
  elements["input-channels"].textContent = channelText;
  elements["playback-input-channels"].textContent = channelText;
  elements["signal-visual"].classList.toggle("has-signal", detected);
  elements["input-badge"].classList.toggle("signal", detected);
  if (appMode === "playback" && liveInput && !tapeCarrierLive) {
    elements["playback-tape-status"].textContent = !detected
      ? `Input below ${noiseGateDb} dBFS noise gate`
      : metrics.pilotDetected
        ? `Audio present · pilot near ${Math.round(metrics.pilotHz)} Hz · acquiring frame`
        : `Audio present at ${levelDb.toFixed(1)} dBFS · no pilot detected`;
  }
  elements["signal-visual"].querySelectorAll(".signal-bars i").forEach((bar, index) => {
    const variation = 0.55 + ((index * 37) % 45) / 100;
    bar.style.height = detected ? `${Math.max(5, meterPercent * variation)}%` : "5%";
  });
}

function codecSelfTest() {
  const duration = SIGNAL.frameDurationMs * 3;
  const samples = generateSignal(duration, (timelineMs, sequence) => ({
    ...frameAt(project, timelineMs),
    sequence
  }));
  const frames = decodeGeneratedSignal(samples);
  if (!frames.length) {
    notify("Codec self-test failed");
    return;
  }
  showDecodedFrame(frames[0], 0);
  setInputMeter(analyzeInputSignal(
    samples.left.subarray(0, 4_096),
    samples.right.subarray(0, 4_096),
    SIGNAL.sampleRate
  ));
  setCarrierUi(true, `${frames.length} clean frames decoded`);
  setTimeout(() => {
    setCarrierUi(false, "Self-test complete");
    if (!liveInput) setInputMeter(null);
  }, 1_800);
  notify(`Codec healthy · ${frames.length} frames passed CRC`);
}

function selectClip(clipId, render = true, focus = false, { additive = false, toggle = false } = {}) {
  const nextIds = additive ? new Set(selectedClipIds) : new Set();
  if (toggle && nextIds.has(clipId)) nextIds.delete(clipId);
  else nextIds.add(clipId);
  setSelectionState([...nextIds], nextIds.has(clipId) ? clipId : [...nextIds][0]);
  updateClipboardButtons();
  if (render) {
    renderTimeline();
    if (focus) elements["timeline-content"].querySelector(`[data-clip-id="${CSS.escape(clipId)}"]`)?.focus({ preventScroll: true });
    return;
  }
  elements["timeline-content"].querySelectorAll(".clip").forEach((element) => {
    element.classList.toggle("selected", selectedClipIds.has(element.dataset.clipId));
  });
  renderInspector();
  if (focus) elements["timeline-content"].querySelector(`[data-clip-id="${CSS.escape(clipId)}"]`)?.focus({ preventScroll: true });
}

function splitSelectedClip() {
  const selected = selectedProjectClip();
  const clip = selected?.zone === "timeline" ? selected.clip : null;
  if (selected?.zone === "buffer") {
    notify("Move this clip to the editing zone before splitting it");
    return;
  }
  if (!clip || playheadMs <= clip.startMs + 500 || playheadMs >= clip.endMs - 500) {
    notify("Place the playhead inside the selected clip");
    return;
  }
  pushHistory();
  const result = splitClip(project, selectedClipId, playheadMs);
  setSelectionState([result.id], result.id);
  renderTimeline();
  saveProject(true);
  notify("Clip split at playhead");
}

function deleteSelectedClip({ recordHistory = true, message = "Clip deleted" } = {}) {
  const selections = selectedProjectClips();
  if (!selections.length) {
    notify("Select a clip before deleting it");
    return false;
  }
  if (recordHistory) pushHistory();
  stopInspectorPreview();
  removeProjectClips(project, selections.map(({ clipId }) => clipId));
  setSelectionState([]);
  playheadMs = Math.min(playheadMs, project.totalDurationMs);
  audioEngine.reset();
  renderTimeline();
  saveProject(true);
  if (message) notify(selections.length > 1 && message === "Clip deleted" ? `${selections.length} clips deleted` : message);
  return true;
}

function copySelectedClip() {
  const selections = selectedProjectClips();
  if (!selections.length) {
    notify("Select a clip before copying or cutting it");
    return false;
  }
  clipClipboard = selections.map(({ clip, zone }) => ({
    clip: structuredClone(clip),
    zone,
    xMs: zone === "buffer" ? clip.bufferXMs : clip.startMs,
    y: zone === "buffer" ? clip.bufferY : 0
  }));
  updateClipboardButtons();
  notify(selections.length > 1 ? `Copied ${selections.length} clips` : `Copied “${selections[0].clip.title}”`);
  return true;
}

function cutSelectedClip() {
  const selectionCount = selectedClipIds.size;
  if (!copySelectedClip()) return;
  deleteSelectedClip({
    recordHistory: true,
    message: selectionCount > 1 ? `${selectionCount} clips cut to internal clipboard` : "Clip cut to internal clipboard"
  });
}

function pasteClip() {
  if (!clipClipboard.length) {
    notify("Copy or cut a clip first");
    return;
  }
  pushHistory();
  const targetZone = pasteTarget.zone === "buffer" ? "buffer" : "timeline";
  const targetMs = pasteTarget.xMs == null ? playheadMs : pasteTarget.xMs;
  const anchorXMs = Math.min(...clipClipboard.map((entry) => entry.xMs));
  const bufferedEntries = clipClipboard.filter((entry) => entry.zone === "buffer");
  const anchorY = bufferedEntries.length ? Math.min(...bufferedEntries.map((entry) => entry.y)) : 0;
  const pastedClips = clipClipboard.map((entry, index) => {
    const pastedXMs = Math.max(0, Math.round(targetMs + entry.xMs - anchorXMs));
    const pasted = duplicateClip(entry.clip, pastedXMs);
    if (targetZone === "buffer") {
      pasted.bufferXMs = pastedXMs;
      pasted.bufferY = Math.max(8, Math.round((pasteTarget.y || 8) + (entry.zone === "buffer" ? entry.y - anchorY : index * 18)));
      project.bufferClips.push(pasted);
    } else {
      delete pasted.bufferXMs;
      delete pasted.bufferY;
      project.clips.push(pasted);
    }
    return pasted;
  });
  if (targetZone === "timeline") {
    const pastedIds = new Set(pastedClips.map((clip) => clip.id));
    pastedClips.forEach((clip) => overwriteLaneWithClip(project, clip.id, pastedIds));
  }
  setSelectionState(pastedClips.map((clip) => clip.id), pastedClips[0]?.id);
  recomputeTimeline(project);
  audioEngine.reset();
  renderTimeline();
  saveProject(true);
  notify(clipClipboard.length > 1
    ? `Pasted ${clipClipboard.length} clips ${targetZone === "buffer" ? "in the buffer" : `at ${formatTime(targetMs, true)}`}`
    : `Pasted “${pastedClips[0].title}” ${targetZone === "buffer" ? "in the buffer" : `at ${formatTime(targetMs, true)}`}`);
}

function updateSelectionUi() {
  elements["timeline-content"].querySelectorAll(".clip").forEach((element) => {
    element.classList.toggle("selected", selectedClipIds.has(element.dataset.clipId));
  });
  updateClipboardButtons();
  renderInspector();
}

function clearClipSelection() {
  setSelectionState([]);
  updateSelectionUi();
}

function selectAllInActiveZone() {
  if (!activeEditorPointerZone) return;
  const clips = activeEditorPointerZone === "buffer" ? project.bufferClips : project.clips;
  setSelectionState(clips.map((clip) => clip.id), clips[0]?.id);
  updateSelectionUi();
  if (clips.length) notify(`Selected ${clips.length} ${activeEditorPointerZone === "buffer" ? "buffer" : `side ${project.activeSide}`} clip${clips.length === 1 ? "" : "s"}`);
}

function nudgeSelected(direction) {
  const selections = selectedProjectClips();
  if (!selections.length) return;
  pushHistory();
  const desiredDeltaMs = direction * 1_000;
  const minimumXMs = Math.min(...selections.map(({ clip, zone }) => zone === "buffer" ? clip.bufferXMs : clip.startMs));
  const deltaMs = Math.max(desiredDeltaMs, -minimumXMs);
  selections.forEach(({ clip, zone }) => {
    if (zone === "buffer") clip.bufferXMs += deltaMs;
    else clip.startMs += deltaMs;
  });
  recomputeTimeline(project);
  renderTimeline();
  saveProject(true);
}

function gainValueFromPointer(event, bounds) {
  const ratio = Math.max(0, Math.min(1, (event.clientY - bounds.top) / Math.max(1, bounds.height)));
  return Math.round((12 - ratio * 72) * 10) / 10;
}

function gainTimeFromPointer(event, bounds, clip) {
  const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
  const raw = ratio * clipDuration(clip);
  return !project.snappingEnabled || event.altKey ? Math.round(raw) : Math.round(raw / 250) * 250;
}

function startGainPointDrag(event, pointElement) {
  if (event.button !== 0) return;
  const clipElement = pointElement.closest("[data-clip-id]");
  const clip = project.clips.find((item) => item.id === clipElement?.dataset.clipId);
  const point = clip?.gainPoints.find((item) => item.id === pointElement.dataset.gainPointId);
  const envelope = pointElement.closest(".gain-envelope");
  if (!clip || !point || !envelope) return;
  event.preventDefault();
  event.stopPropagation();
  selectClip(clip.id, false, true);
  pointElement.setPointerCapture(event.pointerId);
  pointElement.classList.add("dragging");
  gainDragState = {
    pointerId: event.pointerId,
    clip,
    point,
    element: pointElement,
    envelope,
    bounds: envelope.getBoundingClientRect(),
    originX: event.clientX,
    originY: event.clientY,
    moved: false
  };
}

function moveGainPointDrag(event) {
  if (!gainDragState || event.pointerId !== gainDragState.pointerId) return;
  if (!gainDragState.moved && Math.hypot(event.clientX - gainDragState.originX, event.clientY - gainDragState.originY) < 2) return;
  if (!gainDragState.moved) pushHistory();
  gainDragState.moved = true;
  moveGainPoint(
    gainDragState.clip,
    gainDragState.point.id,
    gainTimeFromPointer(event, gainDragState.bounds, gainDragState.clip),
    gainValueFromPointer(event, gainDragState.bounds)
  );
  const duration = Math.max(1, clipDuration(gainDragState.clip));
  gainDragState.element.style.left = `${gainDragState.point.timeMs / duration * 100}%`;
  gainDragState.element.style.top = `${gainPointY(gainDragState.point.gainDb)}%`;
  gainDragState.element.title = `${gainDragState.point.gainDb.toFixed(1)} dB at ${formatTime(gainDragState.point.timeMs, true)}`;
  gainDragState.envelope.querySelector("polyline").setAttribute("points", gainPolyline(gainDragState.clip));
}

function finishGainPointDrag(event) {
  if (!gainDragState || event.pointerId !== gainDragState.pointerId) return;
  const completed = gainDragState;
  gainDragState = null;
  completed.element.classList.remove("dragging");
  if (!completed.moved) return;
  renderTimeline();
  saveProject(true);
  notify(`Gain point · ${completed.point.gainDb.toFixed(1)} dB at ${formatTime(completed.point.timeMs, true)}`);
}

function editGainEnvelope(event, clipElement) {
  const clip = project.clips.find((item) => item.id === clipElement.dataset.clipId);
  const envelope = event.target.closest(".gain-envelope");
  if (!clip || !envelope) return false;
  event.preventDefault();
  event.stopPropagation();
  const pointElement = event.target.closest(".gain-point");
  if (pointElement) {
    const point = clip.gainPoints.find((item) => item.id === pointElement.dataset.gainPointId);
    if (!point || point.timeMs === 0 || point.timeMs === clipDuration(clip)) {
      notify("The first and last gain points are fixed");
      return true;
    }
    pushHistory();
    removeGainPoint(clip, point.id);
    renderTimeline();
    saveProject(true);
    notify("Gain point removed");
    return true;
  }
  pushHistory();
  const bounds = envelope.getBoundingClientRect();
  const point = addGainPoint(
    clip,
    gainTimeFromPointer(event, bounds, clip),
    gainValueFromPointer(event, bounds)
  );
  renderTimeline();
  saveProject(true);
  notify(`Gain point added · ${point.gainDb.toFixed(1)} dB`);
  return true;
}

function startClipDrag(event, clipElement) {
  if (event.button !== 0) return;
  const selected = findProjectClip(project, clipElement.dataset.clipId);
  if (!selected) return;
  const { clip, zone } = selected;
  event.preventDefault();
  event.stopPropagation();
  focusedEditorZone = zone;
  clipElement.focus({ preventScroll: true });
  if (!selectedClipIds.has(clip.id)) selectClip(clip.id, false, true);
  else {
    setSelectionState([...selectedClipIds], clip.id);
    renderInspector();
  }
  clipElement.classList.add("dragging");
  clipElement.setPointerCapture(event.pointerId);
  const elementBounds = clipElement.getBoundingClientRect();
  const members = selectedProjectClips()
    .filter((item) => item.zone === zone)
    .map((item, index) => ({
      ...item,
      element: elements["timeline-content"].querySelector(`[data-clip-id="${CSS.escape(item.clipId)}"]`),
      originXMs: zone === "buffer" ? item.clip.bufferXMs : item.clip.startMs,
      originY: zone === "buffer" ? item.clip.bufferY : 8 + index * 18
    }));
  dragState = {
    pointerId: event.pointerId,
    element: clipElement,
    clip,
    originClientX: event.clientX,
    originClientY: event.clientY,
    originStartMs: clip.startMs,
    originBufferXMs: clip.bufferXMs || 0,
    originBufferY: clip.bufferY || 0,
    originZone: zone,
    targetZone: zone,
    members,
    grabOffsetX: event.clientX - elementBounds.left,
    grabOffsetY: event.clientY - elementBounds.top,
    originScrollLeft: elements["timeline-scroll"].scrollLeft,
    moved: false,
    historyCaptured: false
  };
}

function clipElementAtPointer(event) {
  const direct = event.target.closest?.("[data-clip-id]");
  if (direct) return direct;
  return [...elements["timeline-content"].querySelectorAll("[data-clip-id]")].reverse().find((element) => {
    const bounds = element.getBoundingClientRect();
    return event.clientX >= bounds.left && event.clientX <= bounds.right
      && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
  }) || null;
}

function snapDraggedClip(rawStartMs, clip, excludedIds = new Set([clip.id])) {
  const durationMs = clipDuration(clip);
  const thresholdMs = Math.min(750, Math.max(150, 10 / pixelsPerSecond() * 1_000));
  const edgeTargets = new Set();
  project.clips.forEach((item) => {
    if (excludedIds.has(item.id)) return;
    edgeTargets.add(item.startMs);
    edgeTargets.add(item.endMs);
  });
  return snapClipStart(rawStartMs, durationMs, [...edgeTargets], { thresholdMs });
}

function showSnapGuide(timelineMs) {
  elements["snap-guide"].style.left = `${64 + timelineMs / 1000 * pixelsPerSecond()}px`;
  elements["snap-guide"].classList.add("visible");
}

function hideSnapGuide() {
  elements["snap-guide"].classList.remove("visible");
}

function moveDraggedClip(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const travel = Math.hypot(
    event.clientX - dragState.originClientX,
    event.clientY - dragState.originClientY
  );
  if (!dragState.moved && travel < 3) return;
  if (!dragState.historyCaptured) {
    pushHistory();
    dragState.historyCaptured = true;
  }
  dragState.moved = true;

  const scrollBounds = elements["timeline-scroll"].getBoundingClientRect();
  if (event.clientX > scrollBounds.right - 25) elements["timeline-scroll"].scrollLeft += 14;
  if (event.clientX < scrollBounds.left + 85) elements["timeline-scroll"].scrollLeft -= 14;
  const contentBounds = elements["timeline-content"].getBoundingClientRect();
  const targetZone = event.clientY >= contentBounds.top + project.editorTrackHeight ? "buffer" : "timeline";
  const rawXMs = Math.max(0, (event.clientX - contentBounds.left - 64 - dragState.grabOffsetX) / pixelsPerSecond() * 1_000);
  dragState.targetZone = targetZone;
  const memberIds = new Set(dragState.members.map(({ clipId }) => clipId));
  const primaryMember = dragState.members.find(({ clipId }) => clipId === dragState.clip.id) || dragState.members[0];
  let targetPrimaryXMs = rawXMs;
  if (targetZone === "timeline" && project.snappingEnabled && !event.altKey) {
    const snapped = snapDraggedClip(rawXMs, dragState.clip, memberIds);
    targetPrimaryXMs = snapped.startMs;
    if (snapped.snapped) showSnapGuide(snapped.guideMs);
    else hideSnapGuide();
  } else {
    hideSnapGuide();
  }
  let deltaXMs = targetPrimaryXMs - primaryMember.originXMs;
  deltaXMs = Math.max(deltaXMs, -Math.min(...dragState.members.map((member) => member.originXMs)));
  const bufferBounds = elements["buffer-zone"].getBoundingClientRect();
  const desiredPrimaryY = Math.max(8, Math.min(bufferBounds.height - 84, event.clientY - bufferBounds.top - dragState.grabOffsetY));
  const deltaY = desiredPrimaryY - primaryMember.originY;

  dragState.members.forEach((member) => {
    const memberElement = member.element;
    if (!memberElement) return;
    const xMs = Math.max(0, Math.round(member.originXMs + deltaXMs));
    if (targetZone === "timeline") {
      if (memberElement.parentElement !== elements["clip-lane"]) elements["clip-lane"].append(memberElement);
      memberElement.classList.remove("buffer-clip");
      memberElement.dataset.zone = "timeline";
      member.clip.startMs = xMs;
      member.clip.endMs = xMs + clipDuration(member.clip);
      memberElement.style.left = `${xMs / 1000 * pixelsPerSecond()}px`;
      memberElement.style.top = "32px";
    } else {
      if (memberElement.parentElement !== elements["buffer-canvas"]) elements["buffer-canvas"].append(memberElement);
      memberElement.classList.add("buffer-clip");
      memberElement.dataset.zone = "buffer";
      member.clip.bufferXMs = xMs;
      member.clip.bufferY = Math.max(8, Math.min(bufferBounds.height - 84, member.originY + deltaY));
      memberElement.style.left = `${xMs / 1000 * pixelsPerSecond()}px`;
      memberElement.style.top = `${member.clip.bufferY}px`;
    }
  });
  elements["buffer-zone"].classList.toggle("drop-target", targetZone === "buffer");
}

function finishClipDrag(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const completed = dragState;
  dragState = null;
  hideSnapGuide();
  elements["buffer-zone"].classList.remove("drop-target");
  completed.element.classList.remove("dragging");
  if (completed.moved) {
    suppressClipClickUntil = performance.now() + 200;
    let overwrite = { removed: 0, trimmed: 0, split: 0 };
    const movedIds = new Set(completed.members.map(({ clipId }) => clipId));
    if (completed.targetZone === "buffer" && completed.originZone === "timeline") {
      const movedClips = project.clips.filter((clip) => movedIds.has(clip.id));
      project.clips = project.clips.filter((clip) => !movedIds.has(clip.id));
      movedClips.forEach((clip) => {
        clip.nextClipId = null;
        clip.nextTrackId = "0";
      });
      project.bufferClips.push(...movedClips);
      recomputeTimeline(project);
    } else if (completed.targetZone === "timeline" && completed.originZone === "buffer") {
      const movedClips = project.bufferClips.filter((clip) => movedIds.has(clip.id));
      project.bufferClips = project.bufferClips.filter((clip) => !movedIds.has(clip.id));
      movedClips.forEach((clip) => {
        delete clip.bufferXMs;
        delete clip.bufferY;
      });
      project.clips.push(...movedClips);
      recomputeTimeline(project);
      movedClips.forEach((clip) => {
        const result = overwriteLaneWithClip(project, clip.id, movedIds);
        overwrite.removed += result.removed;
        overwrite.trimmed += result.trimmed;
        overwrite.split += result.split;
      });
    } else if (completed.targetZone === "timeline") {
      recomputeTimeline(project);
      completed.members.forEach(({ clip }) => {
        const result = overwriteLaneWithClip(project, clip.id, movedIds);
        overwrite.removed += result.removed;
        overwrite.trimmed += result.trimmed;
        overwrite.split += result.split;
      });
    } else {
      recomputeTimeline(project);
    }
    if (completed.originZone === "timeline" || completed.targetZone === "timeline") audioEngine.reset();
    renderTimeline();
    saveProject(true);
    const edited = overwrite.removed + overwrite.trimmed + overwrite.split;
    notify(
      (completed.targetZone === "buffer"
        ? `Moved “${completed.clip.title}” to the buffer`
        : `Moved clip to ${formatTime(completed.clip.startMs, true)}`) +
      (edited ? ` · overwrote ${edited} clip${edited === 1 ? "" : "s"}` : "")
    );
  }
}

function toggleEditorPreview() {
  if (!previewPlaying && project.clips.some((clip) => !clip.audioUrl)
    && !requireProviderConnection("preview the timeline")) return;
  if (playheadMs >= project.totalDurationMs) playheadMs = 0;
  setPreviewPlaying(!previewPlaying);
}

function pointerPlacement(event, zone) {
  const contentBounds = elements["timeline-content"].getBoundingClientRect();
  const xMs = Math.max(0, Math.round((event.clientX - contentBounds.left - 64) / pixelsPerSecond() * 1_000));
  if (zone !== "buffer") return { zone: "timeline", xMs, y: 0 };
  const bufferBounds = elements["buffer-zone"].getBoundingClientRect();
  return {
    zone: "buffer",
    xMs,
    y: Math.max(8, Math.round(event.clientY - bufferBounds.top - 38))
  };
}

function updatePlayheadFromPointer(event) {
  const scrollBounds = elements["timeline-scroll"].getBoundingClientRect();
  if (event.clientX > scrollBounds.right - 18) elements["timeline-scroll"].scrollLeft += 16;
  if (event.clientX < scrollBounds.left + 82) elements["timeline-scroll"].scrollLeft -= 16;
  const bounds = elements["timeline-content"].getBoundingClientRect();
  playheadMs = playheadMsFromPointer(
    event.clientX,
    bounds.left,
    pixelsPerSecond(),
    project.totalDurationMs
  );
  pasteTarget = { zone: "timeline", xMs: playheadMs, y: 0 };
  updatePlayhead();
}

function startRulerScrub(event) {
  if (event.button !== 0 || !event.target.closest(".ruler")) return false;
  event.preventDefault();
  focusedEditorZone = "timeline";
  elements["timeline-content"].focus({ preventScroll: true });
  rulerScrubState = { pointerId: event.pointerId };
  elements["timeline-content"].setPointerCapture(event.pointerId);
  updatePlayheadFromPointer(event);
  return true;
}

function moveRulerScrub(event) {
  if (!rulerScrubState || event.pointerId !== rulerScrubState.pointerId) return;
  updatePlayheadFromPointer(event);
}

function finishRulerScrub(event) {
  if (!rulerScrubState || event.pointerId !== rulerScrubState.pointerId) return;
  rulerScrubState = null;
  updatePlayheadFromPointer(event);
  audioEngine.relocate(playheadMs);
  if (previewPlaying) audioEngine.sync(playheadMs, true);
}

function editorZoneAtPointer(event) {
  const bounds = elements["timeline-content"].getBoundingClientRect();
  const localY = event.clientY - bounds.top;
  if (localY >= project.editorTrackHeight + 5 && localY <= bounds.height) return "buffer";
  if (localY >= 28 && localY < project.editorTrackHeight) return "timeline";
  return null;
}

function startMarqueeSelection(event) {
  if (event.button !== 0 || clipElementAtPointer(event) || event.target.closest(".ruler")) return;
  const zone = editorZoneAtPointer(event);
  if (!zone) return;
  event.preventDefault();
  focusedEditorZone = zone;
  elements["timeline-content"].focus({ preventScroll: true });
  const bounds = elements["timeline-content"].getBoundingClientRect();
  marqueeState = {
    pointerId: event.pointerId,
    zone,
    startClientX: event.clientX,
    startClientY: event.clientY,
    currentClientX: event.clientX,
    currentClientY: event.clientY,
    moved: false,
    bounds
  };
  activeEditorPointerZone = zone;
  pasteTarget = pointerPlacement(event, zone);
  elements["timeline-content"].setPointerCapture(event.pointerId);
}

function marqueeRectangle(state) {
  const zoneTop = state.zone === "buffer"
    ? state.bounds.top + project.editorTrackHeight + 5
    : state.bounds.top + 28;
  const zoneBottom = state.zone === "buffer"
    ? state.bounds.bottom
    : state.bounds.top + project.editorTrackHeight;
  const currentY = Math.max(zoneTop, Math.min(zoneBottom, state.currentClientY));
  const startY = Math.max(zoneTop, Math.min(zoneBottom, state.startClientY));
  return {
    left: Math.min(state.startClientX, state.currentClientX),
    right: Math.max(state.startClientX, state.currentClientX),
    top: Math.min(startY, currentY),
    bottom: Math.max(startY, currentY)
  };
}

function moveMarqueeSelection(event) {
  if (!marqueeState || event.pointerId !== marqueeState.pointerId) return;
  marqueeState.currentClientX = event.clientX;
  marqueeState.currentClientY = event.clientY;
  const travel = Math.hypot(event.clientX - marqueeState.startClientX, event.clientY - marqueeState.startClientY);
  if (!marqueeState.moved && travel < 4) return;
  marqueeState.moved = true;
  const rectangle = marqueeRectangle(marqueeState);
  const contentBounds = elements["timeline-content"].getBoundingClientRect();
  const marquee = elements["selection-marquee"];
  marquee.style.left = `${rectangle.left - contentBounds.left}px`;
  marquee.style.top = `${rectangle.top - contentBounds.top}px`;
  marquee.style.width = `${Math.max(1, rectangle.right - rectangle.left)}px`;
  marquee.style.height = `${Math.max(1, rectangle.bottom - rectangle.top)}px`;
  marquee.classList.add("visible");
  const touchedIds = [...elements["timeline-content"].querySelectorAll(`[data-zone="${marqueeState.zone}"]`)]
    .filter((element) => {
      const clipBounds = element.getBoundingClientRect();
      return clipBounds.left <= rectangle.right && clipBounds.right >= rectangle.left
        && clipBounds.top <= rectangle.bottom && clipBounds.bottom >= rectangle.top;
    })
    .map((element) => element.dataset.clipId);
  setSelectionState(touchedIds, touchedIds.at(-1));
  updateSelectionUi();
}

function finishMarqueeSelection(event) {
  if (!marqueeState || event.pointerId !== marqueeState.pointerId) return;
  const completed = marqueeState;
  marqueeState = null;
  elements["selection-marquee"].classList.remove("visible");
  if (completed.moved) {
    suppressClipClickUntil = performance.now() + 150;
    return;
  }
  clearClipSelection();
  if (completed.zone === "timeline") {
    updatePlayheadFromPointer(event);
    audioEngine.relocate(playheadMs);
    if (previewPlaying) audioEngine.sync(playheadMs, true);
  }
}

function handleTimelineWheel(event) {
  if (appMode !== "edit") return;
  activeEditorPointerZone = editorZoneAtPointer(event) || activeEditorPointerZone;
  event.preventDefault();
  const scroll = elements["timeline-scroll"];
  if (!(event.ctrlKey || event.metaKey)) {
    scroll.scrollLeft += event.deltaX + event.deltaY;
    return;
  }
  const bounds = scroll.getBoundingClientRect();
  const pointerX = event.clientX - bounds.left;
  const previousZoom = zoom;
  const previousScrollLeft = scroll.scrollLeft;
  const minimum = Number(elements.zoom.min) || 1;
  const maximum = Number(elements.zoom.max) || 12;
  const step = Number(elements.zoom.step) || 0.25;
  const nextZoom = wheelZoom(zoom, event.deltaY, { min: minimum, max: maximum, step });
  if (nextZoom === zoom) return;
  zoom = nextZoom;
  elements.zoom.value = String(zoom);
  renderTimeline();
  scroll.scrollLeft = cursorAnchoredScrollLeft(previousScrollLeft, pointerX, previousZoom, zoom);
}

function libraryTrackFromElement(element) {
  if (!element) return null;
  if (element.matches("[data-library-index]")) return library[Number(element.dataset.libraryIndex)] || null;
  if (element.matches("[data-collection-track-key]")) {
    return collectionDetails.get(element.dataset.collectionTrackKey)?.tracks?.[Number(element.dataset.collectionTrackIndex)] || null;
  }
  return null;
}

function startLibraryDrag(event) {
  const item = event.target.closest("[data-library-index], [data-collection-track-key]");
  const track = libraryTrackFromElement(item);
  if (!track) return;
  libraryDragTrack = structuredClone(track);
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData("text/plain", `netease:${track.neteaseId}`);
}

function finishLibraryDrag() {
  libraryDragTrack = null;
  elements["buffer-zone"].classList.remove("drop-target");
}

function dragLibraryOverTimeline(event) {
  if (!libraryDragTrack) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  const contentBounds = elements["timeline-content"].getBoundingClientRect();
  elements["buffer-zone"].classList.toggle("drop-target", event.clientY >= contentBounds.top + project.editorTrackHeight);
}

function dropLibraryTrack(event) {
  if (!libraryDragTrack) return;
  event.preventDefault();
  const contentBounds = elements["timeline-content"].getBoundingClientRect();
  const zone = event.clientY >= contentBounds.top + project.editorTrackHeight ? "buffer" : "timeline";
  const placement = pointerPlacement(event, zone);
  const track = libraryDragTrack;
  finishLibraryDrag();
  pasteTarget = placement;
  addTrack(track, placement);
}

function handleEditorShortcut(event) {
  if (appMode !== "edit") return;
  if (event.repeat) return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
  const command = editorShortcut(event);
  if (!command) return;
  if ((command === "select-all" || command === "clear-selection") && !activeEditorPointerZone) return;
  if (command === "toggle-playback"
    && (focusedEditorZone !== "timeline" || !elements["timeline-content"].contains(target))) return;
  event.preventDefault();
  if (command === "undo") undo();
  else if (command === "redo") redo();
  else if (command === "copy") copySelectedClip();
  else if (command === "cut") cutSelectedClip();
  else if (command === "paste") pasteClip();
  else if (command === "delete") deleteSelectedClip();
  else if (command === "select-all") selectAllInActiveZone();
  else if (command === "clear-selection") clearClipSelection();
  else if (command === "toggle-playback") toggleEditorPreview();
}

function visibleCollectionKeys() {
  return [...elements["mixtape-list"].querySelectorAll("[data-node-key]")]
    .map((element) => element.dataset.nodeKey);
}

function selectCollectionNode(key, event = {}) {
  const toggle = Boolean(event.ctrlKey || event.metaKey);
  if (event.shiftKey && collectionSelectionAnchor) {
    const keys = visibleCollectionKeys();
    const anchorIndex = keys.indexOf(collectionSelectionAnchor);
    const currentIndex = keys.indexOf(key);
    if (anchorIndex >= 0 && currentIndex >= 0) {
      if (!toggle) selectedCollectionKeys.clear();
      const [start, end] = anchorIndex < currentIndex ? [anchorIndex, currentIndex] : [currentIndex, anchorIndex];
      for (const rangeKey of keys.slice(start, end + 1)) selectedCollectionKeys.add(rangeKey);
    }
  } else if (toggle) {
    if (selectedCollectionKeys.has(key)) selectedCollectionKeys.delete(key);
    else selectedCollectionKeys.add(key);
    collectionSelectionAnchor = key;
  } else {
    selectedCollectionKeys = new Set([key]);
    collectionSelectionAnchor = key;
  }
  renderMixtapeList();
}

function hideMixtapeContextMenu() {
  elements["mixtape-context-menu"].hidden = true;
}

function showMixtapeContextMenu(event, key) {
  if (!selectedCollectionKeys.has(key)) {
    selectedCollectionKeys = new Set([key]);
    collectionSelectionAnchor = key;
    renderMixtapeList();
  }
  const menu = elements["mixtape-context-menu"];
  const directMixtapes = selectedMixtapeIds();
  const deletingMixtapes = selectedMixtapeIds(selectedCollectionKeys, { includeGroups: true });
  menu.querySelector('[data-mixtape-menu-action="rename"]').disabled = selectedCollectionKeys.size !== 1;
  menu.querySelector('[data-mixtape-menu-action="group"]').disabled = directMixtapes.size === 0;
  menu.querySelector('[data-mixtape-menu-action="delete"]').disabled =
    deletingMixtapes.size > 0 && deletingMixtapes.size >= mixtapeStore.items.length;
  menu.hidden = false;
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(event.clientX, window.innerWidth - bounds.width - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(event.clientY, window.innerHeight - bounds.height - 6))}px`;
  menu.querySelector("button:not(:disabled)")?.focus();
}

function openCollectionRenameDialog() {
  if (selectedCollectionKeys.size !== 1) return;
  const key = [...selectedCollectionKeys][0];
  const node = parseCollectionNodeKey(key);
  if (!node) return;
  const target = node.type === "group"
    ? mixtapeStore.groups.find((group) => group.id === node.id)
    : mixtapeStore.items.find((item) => item.id === node.id);
  if (!target) return;
  pendingRenameCollectionKey = key;
  elements["mixtape-rename-title"].textContent = `Rename ${node.type}`;
  elements["mixtape-rename-name"].value = target.name || (node.type === "group" ? "Untitled Group" : "Untitled Mixtape");
  elements["mixtape-rename-dialog"].showModal();
  elements["mixtape-rename-name"].focus();
  elements["mixtape-rename-name"].select();
}

function renamePendingCollectionNode() {
  const node = parseCollectionNodeKey(pendingRenameCollectionKey);
  const name = elements["mixtape-rename-name"].value.trim();
  pendingRenameCollectionKey = null;
  if (!node || !name) return;
  if (node.type === "group") {
    const group = mixtapeStore.groups.find((candidate) => candidate.id === node.id);
    if (!group) return;
    group.name = name;
    persistSavedMixtapes();
    renderMixtapeList();
  } else if (node.id === project.id) {
    project.name = name;
    elements["project-name"].value = name;
    saveProject(true);
  } else {
    const mixtape = mixtapeStore.items.find((item) => item.id === node.id);
    if (!mixtape) return;
    mixtape.name = name;
    mixtape.updatedAt = Date.now();
    persistSavedMixtapes();
    renderMixtapeList();
  }
  notify(`Renamed to ${name}`);
}

function openMixtapeGroupDialog(mixtapeIds = []) {
  pendingGroupMixtapeIds = [...new Set(mixtapeIds)]
    .filter((id) => mixtapeStore.items.some((item) => item.id === id));
  elements["mixtape-group-name"].value = `Group ${mixtapeStore.groups.length + 1}`;
  elements["mixtape-group-dialog"].showModal();
  elements["mixtape-group-name"].focus();
  elements["mixtape-group-name"].select();
}

function createPendingMixtapeGroup() {
  const name = elements["mixtape-group-name"].value.trim() || "Untitled Group";
  const group = {
    id: `mixtape-group-${Date.now()}-${mixtapeGroupSeed++}`,
    name,
    itemIds: [],
    collapsed: false
  };
  for (const mixtapeId of pendingGroupMixtapeIds) {
    removeMixtapeFromLayout(mixtapeStore, mixtapeId);
    group.itemIds.push(mixtapeId);
  }
  mixtapeStore.groups.push(group);
  mixtapeStore.order.push({ type: "group", id: group.id });
  const groupKey = collectionNodeKey("group", group.id);
  selectedCollectionKeys = new Set([groupKey]);
  collectionSelectionAnchor = groupKey;
  pendingGroupMixtapeIds = [];
  persistSavedMixtapes();
  renderMixtapeList();
  notify(`${name} created`);
}

function duplicateMixtapeProject(source) {
  const duplicate = structuredClone(source);
  duplicate.id = createProject().id;
  duplicate.name = `${source.name || "Untitled Mixtape"} Copy`;
  duplicate.updatedAt = Date.now();
  return duplicate;
}

function duplicateCollectionSelection() {
  saveProject(true);
  const selectedGroups = new Set([...selectedCollectionKeys]
    .map(parseCollectionNodeKey)
    .filter((node) => node?.type === "group")
    .map((node) => node.id));
  const modelKeys = [];
  for (const node of mixtapeStore.order) {
    modelKeys.push(collectionNodeKey(node.type, node.id));
    if (node.type === "group") {
      const group = mixtapeStore.groups.find((candidate) => candidate.id === node.id);
      for (const itemId of group?.itemIds || []) modelKeys.push(collectionNodeKey("mixtape", itemId));
    }
  }

  const newKeys = [];
  for (const key of modelKeys.filter((candidate) => selectedCollectionKeys.has(candidate))) {
    const node = parseCollectionNodeKey(key);
    if (!node) continue;
    if (node.type === "group") {
      const sourceGroup = mixtapeStore.groups.find((group) => group.id === node.id);
      if (!sourceGroup) continue;
      const duplicateGroup = {
        id: `mixtape-group-${Date.now()}-${mixtapeGroupSeed++}`,
        name: `${sourceGroup.name} Copy`,
        itemIds: [],
        collapsed: sourceGroup.collapsed
      };
      for (const itemId of sourceGroup.itemIds) {
        const sourceItem = mixtapeStore.items.find((item) => item.id === itemId);
        if (!sourceItem) continue;
        const duplicate = duplicateMixtapeProject(sourceItem);
        mixtapeStore.items.push(duplicate);
        duplicateGroup.itemIds.push(duplicate.id);
      }
      mixtapeStore.groups.push(duplicateGroup);
      const sourceIndex = mixtapeStore.order.findIndex((candidate) => candidate.type === "group" && candidate.id === sourceGroup.id);
      mixtapeStore.order.splice(sourceIndex + 1, 0, { type: "group", id: duplicateGroup.id });
      newKeys.push(collectionNodeKey("group", duplicateGroup.id));
      continue;
    }

    const parentGroup = mixtapeStore.groups.find((group) => group.itemIds.includes(node.id));
    if (parentGroup && selectedGroups.has(parentGroup.id)) continue;
    const sourceItem = mixtapeStore.items.find((item) => item.id === node.id);
    if (!sourceItem) continue;
    const duplicate = duplicateMixtapeProject(sourceItem);
    mixtapeStore.items.push(duplicate);
    if (parentGroup) {
      const sourceIndex = parentGroup.itemIds.indexOf(sourceItem.id);
      parentGroup.itemIds.splice(sourceIndex + 1, 0, duplicate.id);
    } else {
      const sourceIndex = mixtapeStore.order.findIndex((candidate) => candidate.type === "mixtape" && candidate.id === sourceItem.id);
      mixtapeStore.order.splice(sourceIndex + 1, 0, { type: "mixtape", id: duplicate.id });
    }
    newKeys.push(collectionNodeKey("mixtape", duplicate.id));
  }

  if (!newKeys.length) return;
  selectedCollectionKeys = new Set(newKeys);
  collectionSelectionAnchor = newKeys[0];
  persistSavedMixtapes();
  renderMixtapeList();
  notify(`${newKeys.length} item${newKeys.length === 1 ? "" : "s"} duplicated`);
}

function clearCollectionDropIndicators() {
  elements["mixtape-list"].querySelectorAll(".drop-before, .drop-after, .drop-inside")
    .forEach((element) => element.classList.remove("drop-before", "drop-after", "drop-inside"));
  collectionDropTarget = null;
}

function collectionDragOver(event) {
  if (!collectionDragKey || mixtapeSearchQuery.trim()) return;
  const source = parseCollectionNodeKey(collectionDragKey);
  if (!source) return;
  clearCollectionDropIndicators();
  const emptyGroup = event.target.closest("[data-group-empty-id]");
  let nodeElement = event.target.closest("[data-node-key]");
  let position = "after";

  if (emptyGroup && source.type === "mixtape") {
    nodeElement = emptyGroup.closest('[data-node-key^="group:"]');
    position = "inside";
  } else if (nodeElement) {
    const target = parseCollectionNodeKey(nodeElement.dataset.nodeKey);
    if (!target) return;
    const bounds = nodeElement.getBoundingClientRect();
    const ratio = bounds.height ? (event.clientY - bounds.top) / bounds.height : 0.5;
    const overGroupHeader = Boolean(event.target.closest(".mixtape-group-header"));
    if (target.type === "group" && source.type === "mixtape" && (overGroupHeader || ratio > 0.25 && ratio < 0.75)) position = "inside";
    else position = ratio < 0.5 ? "before" : "after";
    if (source.type === "group" && nodeElement.closest(".mixtape-group-children")) return;
  } else if (event.target.closest("#mixtape-list")) {
    collectionDropTarget = { target: null, position: "end" };
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    return;
  } else {
    return;
  }

  const target = parseCollectionNodeKey(nodeElement.dataset.nodeKey);
  if (!target || collectionNodeKey(target.type, target.id) === collectionDragKey && position !== "inside") return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  collectionDropTarget = { target, position };
  nodeElement.classList.add(position === "inside" ? "drop-inside" : `drop-${position}`);
}

function moveMixtapeRelative(mixtapeId, target, position) {
  if (!target) {
    insertMixtapeInLayout(mixtapeStore, mixtapeId);
    return;
  }
  if (target.type === "group" && position === "inside") {
    insertMixtapeInLayout(mixtapeStore, mixtapeId, { groupId: target.id });
    const group = mixtapeStore.groups.find((candidate) => candidate.id === target.id);
    if (group) group.collapsed = false;
    return;
  }

  const targetGroup = target.type === "mixtape"
    ? mixtapeStore.groups.find((group) => group.itemIds.includes(target.id))
    : null;
  removeMixtapeFromLayout(mixtapeStore, mixtapeId);
  if (targetGroup) {
    const targetIndex = targetGroup.itemIds.indexOf(target.id);
    insertMixtapeInLayout(mixtapeStore, mixtapeId, {
      groupId: targetGroup.id,
      index: targetIndex + (position === "after" ? 1 : 0)
    });
    return;
  }
  const targetIndex = mixtapeStore.order.findIndex((node) => node.type === target.type && node.id === target.id);
  insertMixtapeInLayout(mixtapeStore, mixtapeId, { index: targetIndex + (position === "after" ? 1 : 0) });
}

function finishCollectionDrop(event) {
  if (!collectionDragKey || !collectionDropTarget) return;
  event.preventDefault();
  const source = parseCollectionNodeKey(collectionDragKey);
  const { target, position } = collectionDropTarget;
  if (!source) return;
  const targetIsTopLevel = !target || mixtapeStore.order.some((node) =>
    node.type === target.type && node.id === target.id
  );
  if (source.type === "mixtape" && target?.type === "group" && position === "inside") {
    moveMixtapesToGroup(mixtapeStore, collectionDragMixtapeIds.length ? collectionDragMixtapeIds : [source.id], target.id);
  } else if (source.type === "mixtape" && targetIsTopLevel) {
    moveMixtapesToTopLevel(
      mixtapeStore,
      collectionDragMixtapeIds.length ? collectionDragMixtapeIds : [source.id],
      target,
      position
    );
  } else if (source.type === "mixtape") {
    moveMixtapeRelative(source.id, target, position);
  } else if (!target) {
    moveTopLevelNode(mixtapeStore, source, mixtapeStore.order.length);
  } else if (target.type === "group" || !mixtapeStore.groups.some((group) => group.itemIds.includes(target.id))) {
    const targetIndex = mixtapeStore.order.findIndex((node) => node.type === target.type && node.id === target.id);
    moveTopLevelNode(mixtapeStore, source, targetIndex + (position === "after" ? 1 : 0));
  }
  clearCollectionDropIndicators();
  collectionDragKey = null;
  collectionDragMixtapeIds = [];
  persistSavedMixtapes();
  renderMixtapeList();
}

elements["mixtape-list"].addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-toggle-group-id]");
  if (toggle) {
    const group = mixtapeStore.groups.find((candidate) => candidate.id === toggle.dataset.toggleGroupId);
    if (group) {
      group.collapsed = !group.collapsed;
      persistSavedMixtapes();
      renderMixtapeList();
    }
    return;
  }
  const nodeElement = event.target.closest("[data-node-key]");
  if (!nodeElement) {
    selectedCollectionKeys.clear();
    collectionSelectionAnchor = null;
    renderMixtapeList();
    return;
  }
  const key = nodeElement.dataset.nodeKey;
  const node = parseCollectionNodeKey(key);
  selectCollectionNode(key, event);
  if (node?.type === "mixtape" && !event.ctrlKey && !event.metaKey && !event.shiftKey) openMixtape(node.id);
});
elements["mixtape-list"].addEventListener("contextmenu", (event) => {
  const nodeElement = event.target.closest("[data-node-key]");
  if (!nodeElement) return;
  event.preventDefault();
  showMixtapeContextMenu(event, nodeElement.dataset.nodeKey);
});
elements["mixtape-list"].addEventListener("dragstart", (event) => {
  const nodeElement = event.target.closest("[data-node-key]");
  if (!nodeElement || mixtapeSearchQuery.trim()) {
    event.preventDefault();
    return;
  }
  collectionDragKey = nodeElement.dataset.nodeKey;
  if (!selectedCollectionKeys.has(collectionDragKey)) {
    selectedCollectionKeys = new Set([collectionDragKey]);
    collectionSelectionAnchor = collectionDragKey;
  }
  const source = parseCollectionNodeKey(collectionDragKey);
  collectionDragMixtapeIds = source?.type === "mixtape" ? orderedSelectedMixtapeIds() : [];
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", collectionDragKey);
  requestAnimationFrame(() => {
    const draggingKeys = new Set(collectionDragMixtapeIds.map((id) => collectionNodeKey("mixtape", id)));
    elements["mixtape-list"].querySelectorAll("[data-node-key]").forEach((element) => {
      if (element.dataset.nodeKey === collectionDragKey || draggingKeys.has(element.dataset.nodeKey)) {
        element.classList.add("dragging");
      }
    });
  });
});
elements["mixtape-list"].addEventListener("dragover", collectionDragOver);
elements["mixtape-list"].addEventListener("drop", finishCollectionDrop);
elements["mixtape-list"].addEventListener("dragend", () => {
  collectionDragKey = null;
  collectionDragMixtapeIds = [];
  clearCollectionDropIndicators();
  renderMixtapeList();
});
elements["new-mixtape"].addEventListener("click", createNewMixtape);
elements["new-mixtape-group"].addEventListener("click", () => openMixtapeGroupDialog());
elements["mixtape-search"].addEventListener("input", (event) => {
  mixtapeSearchQuery = event.currentTarget.value;
  renderMixtapeList();
});
elements["delete-mixtape-form"].addEventListener("submit", (event) => {
  if (event.submitter?.value !== "default") return;
  event.preventDefault();
  deletePendingSelection();
  elements["delete-mixtape-dialog"].close("default");
});
elements["delete-mixtape-dialog"].addEventListener("close", () => {
  pendingDeleteSelectionKeys = [];
});
elements["mixtape-group-form"].addEventListener("submit", (event) => {
  if (event.submitter?.value !== "default") return;
  event.preventDefault();
  createPendingMixtapeGroup();
  elements["mixtape-group-dialog"].close("default");
});
elements["mixtape-group-dialog"].addEventListener("close", () => {
  pendingGroupMixtapeIds = [];
});
elements["mixtape-rename-form"].addEventListener("submit", (event) => {
  if (event.submitter?.value !== "default") return;
  event.preventDefault();
  renamePendingCollectionNode();
  elements["mixtape-rename-dialog"].close("default");
});
elements["mixtape-rename-dialog"].addEventListener("close", () => {
  pendingRenameCollectionKey = null;
});
elements["mixtape-context-menu"].addEventListener("click", (event) => {
  const action = event.target.closest("[data-mixtape-menu-action]")?.dataset.mixtapeMenuAction;
  if (!action || event.target.disabled) return;
  hideMixtapeContextMenu();
  if (action === "rename") openCollectionRenameDialog();
  else if (action === "delete") requestDeleteSelection();
  else if (action === "duplicate") duplicateCollectionSelection();
  else if (action === "group") openMixtapeGroupDialog([...selectedMixtapeIds()]);
});
document.addEventListener("pointerdown", (event) => {
  if (!elements["mixtape-context-menu"].contains(event.target)) hideMixtapeContextMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideMixtapeContextMenu();
});
elements["mixtape-list"].addEventListener("scroll", hideMixtapeContextMenu);
elements["library-list"].addEventListener("click", (event) => {
  const importButton = event.target.closest("[data-import-collection-key]");
  if (importButton) {
    openCollectionImport(importButton.dataset.importCollectionKey);
    return;
  }
  const collectionTrack = event.target.closest("[data-collection-track-key]");
  if (collectionTrack) {
    const detail = collectionDetails.get(collectionTrack.dataset.collectionTrackKey);
    const track = detail?.tracks?.[Number(collectionTrack.dataset.collectionTrackIndex)];
    if (track) addTrack(track);
    return;
  }
  const collection = event.target.closest("[data-collection-index]");
  if (collection) {
    toggleLibraryCollection(Number(collection.dataset.collectionIndex));
    return;
  }
  const item = event.target.closest("[data-library-index]");
  if (item) addTrack(library[Number(item.dataset.libraryIndex)]);
});
elements["library-list"].addEventListener("dragstart", startLibraryDrag);
elements["library-list"].addEventListener("dragend", finishLibraryDrag);
document.querySelectorAll("[data-library-mode]").forEach((button) => {
  button.addEventListener("click", () => setLibraryMode(button.dataset.libraryMode));
});
elements["search-input"].addEventListener("keydown", (event) => {
  if (event.key === "Enter") searchNetease(event.currentTarget.value);
});
elements["search-input"].addEventListener("input", (event) => {
  if (!event.currentTarget.value) searchNetease("");
});
document.querySelectorAll("[data-import-tape-length]").forEach((button) => {
  button.addEventListener("click", () => setCollectionImportTapeLength(button.dataset.importTapeLength));
});
elements["collection-tape-slider"].addEventListener("input", (event) => {
  setCollectionImportTapeLength(event.currentTarget.value);
});
elements["collection-tape-custom"].addEventListener("input", (event) => {
  setCollectionImportTapeLength(event.currentTarget.value);
});
elements["collection-import-cover"].addEventListener("error", () => {
  elements["collection-import-cover"].parentElement.classList.remove("has-cover");
});
elements["collection-import-form"].addEventListener("submit", (event) => {
  if (event.submitter?.value !== "default") return;
  event.preventDefault();
  importPendingCollection();
  elements["collection-import-dialog"].close("default");
});
elements["collection-import-dialog"].addEventListener("close", () => {
  pendingCollectionImport = null;
});
elements["timeline-content"].addEventListener("click", (event) => {
  if (performance.now() < suppressClipClickUntil) return;
  const clip = clipElementAtPointer(event);
  if (!clip) return;
  selectClip(clip.dataset.clipId, false, true, {
    additive: event.ctrlKey || event.metaKey || event.shiftKey,
    toggle: event.ctrlKey || event.metaKey
  });
});
elements["timeline-content"].addEventListener("focusin", (event) => {
  const clip = event.target.closest("[data-clip-id]");
  if (clip) focusedEditorZone = clip.dataset.zone === "buffer" ? "buffer" : "timeline";
  else if (event.target === elements["timeline-content"] && !focusedEditorZone) focusedEditorZone = "timeline";
  if (clip && !selectedClipIds.has(clip.dataset.clipId)) selectClip(clip.dataset.clipId, false);
});
elements["timeline-content"].addEventListener("dblclick", (event) => {
  const clip = clipElementAtPointer(event);
  if (!clip) return;
  if (event.target.closest(".gain-envelope") && editGainEnvelope(event, clip)) return;
  setSelectionState([clip.dataset.clipId], clip.dataset.clipId);
  splitSelectedClip();
});
elements["timeline-content"].addEventListener("pointerdown", (event) => {
  if (startRulerScrub(event)) return;
  const clip = clipElementAtPointer(event);
  const point = event.target.closest(".gain-point");
  if (point) {
    startGainPointDrag(event, point);
    return;
  }
  if (event.target.closest(".gain-envelope")) return;
  if (clip) {
    startClipDrag(event, clip);
    return;
  }
  startMarqueeSelection(event);
});
elements["timeline-content"].addEventListener("pointermove", (event) => {
  activeEditorPointerZone = editorZoneAtPointer(event) || activeEditorPointerZone;
  moveGainPointDrag(event);
  moveDraggedClip(event);
  moveMarqueeSelection(event);
  moveRulerScrub(event);
});
elements["timeline-content"].addEventListener("pointerup", (event) => {
  finishGainPointDrag(event);
  finishClipDrag(event);
  finishMarqueeSelection(event);
  finishRulerScrub(event);
});
elements["timeline-content"].addEventListener("pointercancel", (event) => {
  finishGainPointDrag(event);
  finishClipDrag(event);
  finishMarqueeSelection(event);
  finishRulerScrub(event);
});
elements["timeline-scroll"].addEventListener("wheel", handleTimelineWheel, { passive: false });
elements["timeline-content"].addEventListener("pointerleave", () => {
  if (!dragState && !marqueeState && !rulerScrubState) activeEditorPointerZone = null;
});
elements["timeline-content"].addEventListener("dragover", dragLibraryOverTimeline);
elements["timeline-content"].addEventListener("drop", dropLibraryTrack);
elements["timeline-content"].addEventListener("dragleave", (event) => {
  if (!elements["timeline-content"].contains(event.relatedTarget)) elements["buffer-zone"].classList.remove("drop-target");
});
elements["inspector-fields"].addEventListener("change", (event) => {
  const input = event.target.closest("input[data-field]");
  const clip = selectedProjectClip()?.clip;
  if (!input || !clip || input.readOnly) return;
  pushHistory();
  const field = input.dataset.field;
  const value = Number(input.value);
  if (field === "gainDb") {
    const nextGain = Math.max(-60, Math.min(12, value));
    const delta = nextGain - clip.gainDb;
    clip.gainDb = nextGain;
    clip.gainPoints.forEach((point) => {
      point.gainDb = Math.max(-60, Math.min(12, point.gainDb + delta));
    });
  } else {
    clip[field] = Math.max(0, value * 1000);
    if (field === "trimStartMs") clip.trimStartMs = Math.min(clip.trimStartMs, clip.trimEndMs - 500);
    if (field === "trimEndMs") clip.trimEndMs = Math.min(clip.durationMs, Math.max(clip.trimEndMs, clip.trimStartMs + 500));
  }
  renderTimeline();
  saveProject(true);
});
elements.zoom.addEventListener("input", (event) => {
  zoom = Number(event.target.value);
  renderTimeline();
});
elements["play-toggle"].addEventListener("click", toggleEditorPreview);
elements["skip-start"].addEventListener("click", () => {
  playheadMs = 0;
  updatePlayhead();
});
elements["skip-next"].addEventListener("click", () => {
  const next = timelineOrder(project).find((clip) => clip.startMs > playheadMs + 20);
  playheadMs = next?.startMs ?? project.totalDurationMs;
  updatePlayhead();
});
elements["mode-edit"].addEventListener("click", () => setMode("edit"));
elements["mode-playback"].addEventListener("click", () => setMode("playback", { armInput: true }));
elements["mode-monitor"].addEventListener("click", () => setMode("monitor"));
elements["back-to-edit"].addEventListener("click", () => setMode("edit"));
elements["playback-cover"].addEventListener("error", () => {
  elements["playback-cover"].parentElement.classList.remove("has-cover");
  elements["playback-backdrop"].style.backgroundImage = "";
});
elements["split-clip"].addEventListener("click", splitSelectedClip);
elements["delete-clip"].addEventListener("click", () => deleteSelectedClip());
elements["move-left"].addEventListener("click", () => nudgeSelected(-1));
elements["move-right"].addEventListener("click", () => nudgeSelected(1));
elements["inspector-preview-toggle"].addEventListener("click", toggleInspectorPreview);
elements["inspector-preview-seek"].addEventListener("input", (event) => {
  const clip = selectedProjectClip()?.clip;
  if (!clip) return;
  const localMs = clipDuration(clip) * Number(event.currentTarget.value) / 1000;
  elements["inspector-preview-time"].textContent = formatTime(localMs, true);
  if (inspectorPreview?.audio && inspectorPreview.clip.id === clip.id) {
    inspectorPreview.audio.currentTime = (clip.trimStartMs + localMs) / 1000;
  }
});
elements["undo-action"].addEventListener("click", undo);
elements["redo-action"].addEventListener("click", redo);
elements["copy-clip"].addEventListener("click", copySelectedClip);
elements["paste-clip"].addEventListener("click", pasteClip);
elements["side-a"].addEventListener("click", () => switchProjectSide("A"));
elements["side-b"].addEventListener("click", () => switchProjectSide("B"));
elements["tape-length-slider"].addEventListener("input", (event) => setTapeLength(event.currentTarget.value));
elements["tape-length-custom"].addEventListener("change", (event) => setTapeLength(event.currentTarget.value));
elements["snap-toggle"].addEventListener("click", () => {
  project.snappingEnabled = !project.snappingEnabled;
  if (!project.snappingEnabled) hideSnapGuide();
  updateCassetteControls();
  saveProject(true);
  notify(`Snapping ${project.snappingEnabled ? "enabled" : "disabled"}`);
});
elements["project-name"].addEventListener("input", scheduleProjectAutosave);
elements["project-name"].addEventListener("change", () => saveProject(true));
elements["export-wav"].addEventListener("click", exportWav);
elements["open-dubbing"].addEventListener("click", async () => {
  if (preparedDubbing && preparedDubbing.key !== dubbingPreparationKey()) {
    discardPreparedDubbing();
  }
  updateCassetteControls();
  await refreshOutputDevices();
  updateMusicQualityUi();
  updateDubbingModeUi();
  elements["dubbing-dialog"].showModal();
});
elements["close-dubbing"].addEventListener("click", () => elements["dubbing-dialog"].close());
elements["preload-dubbing"].addEventListener("click", preloadDubbing);
elements["start-dubbing"].addEventListener("click", startPreparedDubbing);
elements["stop-dubbing"].addEventListener("click", stopOrCancelDubbing);
elements["refresh-outputs"].addEventListener("click", () => refreshOutputDevices());
elements["dub-output-device"].addEventListener("change", changeDubbingOutput);
elements["dub-actual-music"].addEventListener("change", changeDubbingSource);
elements["dub-music-monitor"].addEventListener("change", () => {
  discardPreparedDubbing();
  if (elements["dub-music-monitor"].checked && !requireProviderConnection("enable music monitoring")) {
    elements["dub-music-monitor"].checked = false;
    return;
  }
  audioRouting.musicMonitoring = elements["dub-music-monitor"].checked;
  saveAudioRouting();
  if (!elements["dub-music-monitor"].checked) setPreviewPlaying(false);
});
elements["dubbing-dialog"].addEventListener("close", () => {
  if (dubbingSession) stopDubbing();
  else if (dubbingPreloadPending) discardPreparedDubbing();
});
elements["dubbing-cancel-form"].addEventListener("submit", (event) => {
  if (event.submitter?.value !== "default") return;
  event.preventDefault();
  discardPreparedDubbing();
  updateDubbingModeUi();
  elements["dubbing-cancel-dialog"].close("default");
});
elements["open-settings"].addEventListener("click", openAudioSettings);
elements["close-settings"].addEventListener("click", () => elements["settings-dialog"].close());
elements["done-settings"].addEventListener("click", () => elements["settings-dialog"].close());
elements["refresh-audio-devices"].addEventListener("click", () => {
  nativeAudio?.command({ type: "listDevices" }).catch(() => {});
  return Promise.all([refreshInputDevices(), refreshOutputDevices()]);
});
elements["settings-playback-output"].addEventListener("change", changePlaybackOutput);
elements["settings-dubbing-output"].addEventListener("change", changeDubbingOutput);
elements["settings-music-quality"].addEventListener("change", changeMusicQuality);
elements["dub-music-quality"].addEventListener("change", changeMusicQuality);
elements["settings-language"].addEventListener("change", changeLanguage);
elements["settings-input-device"].addEventListener("change", changeInputDevice);
elements["settings-noise-gate"].addEventListener("input", changeInputNoiseGate);
elements["settings-noise-gate"].addEventListener("change", () => {
  notify(`Input noise gate set to ${audioRouting.inputNoiseGateDb} dBFS`);
});
elements["start-input"].addEventListener("click", startLiveInput);
elements["refresh-inputs"].addEventListener("click", () => nativeAudio
  ? nativeAudio.command({ type: "listDevices" })
  : refreshInputDevices());
elements["playback-refresh-inputs"].addEventListener("click", () => nativeAudio
  ? nativeAudio.command({ type: "listDevices" })
  : refreshInputDevices());
elements["input-device"].addEventListener("change", changeInputDevice);
elements["playback-input-device"].addEventListener("change", changeInputDevice);
elements["eq-profile-select"].addEventListener("change", (event) => selectDiagnostic(event.currentTarget.value));
elements["delete-eq-profile"].addEventListener("click", () => {
  const report = selectedDiagnostic();
  if (!report) return;
  diagnosticStore.reports = diagnosticStore.reports.filter((item) => item.id !== report.id);
  diagnosticStore.activeId = diagnosticStore.reports.at(-1)?.id || "";
  saveDiagnostics();
  renderDiagnostics();
  setEqCalibrationStatus("Report deleted", "Choose another saved report or upload a new test recording.");
});
elements["eq-calibration-output"].addEventListener("change", changeDubbingOutput);
elements["eq-record-signal"].addEventListener("click", recordEqCalibrationSignal);
elements["eq-calibration-file"].addEventListener("change", (event) => analyzeEqCalibrationFile(event.currentTarget.files?.[0]));
elements["eq-file-port"].addEventListener("dragover", (event) => {
  event.preventDefault();
  if (!elements["eq-calibration-file"].disabled) elements["eq-file-port"].classList.add("dragging");
});
elements["eq-file-port"].addEventListener("dragleave", () => elements["eq-file-port"].classList.remove("dragging"));
elements["eq-file-port"].addEventListener("drop", (event) => {
  event.preventDefault();
  elements["eq-file-port"].classList.remove("dragging");
  if (!elements["eq-calibration-file"].disabled) analyzeEqCalibrationFile(event.dataTransfer?.files?.[0]);
});
elements["eq-cancel-calibration"].addEventListener("click", () => stopEqCalibration());
elements["loopback-test"].addEventListener("click", codecSelfTest);
elements["netease-account-action"].addEventListener("click", providerAction);
elements["close-provider-warning"].addEventListener("click", closeProviderWarning);
elements["dismiss-provider-warning"].addEventListener("click", closeProviderWarning);
elements["provider-warning-settings"].addEventListener("click", async () => {
  closeProviderWarning();
  await openAudioSettings();
});
elements["close-login"].addEventListener("click", closeLoginDialog);
elements["login-dialog"].addEventListener("close", () => {
  clearTimeout(loginPollTimer);
  loginPollTimer = 0;
});
elements["track-form"].addEventListener("submit", (event) => {
  if (event.submitter?.value !== "default") return;
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  addTrack({
    neteaseId: data.get("neteaseId"),
    title: data.get("title"),
    artist: data.get("artist") || "Unknown artist",
    album: data.get("album") || "Unknown album",
    durationMs: (Number(data.get("minutes")) * 60 + Number(data.get("seconds"))) * 1000
  });
  elements["track-dialog"].close();
  event.currentTarget.reset();
});
window.addEventListener("resize", renderTimeline);
window.addEventListener("beforeunload", () => saveProject(true));
window.addEventListener("pointerdown", (event) => {
  if (!elements["timeline-content"].contains(event.target)) focusedEditorZone = null;
}, true);
window.addEventListener("keydown", handleEditorShortcut);
navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  refreshInputDevices();
  refreshOutputDevices();
  nativeAudio?.command({ type: "listDevices" }).catch(() => {});
});

if (nativeAudio) {
  nativeAudio.onEvent(handleNativeAudioEvent);
  nativeAudio.getState().then((state) => {
    for (const event of state?.events || []) handleNativeAudioEvent(event);
    nativeAudio.command({ type: "listDevices" }).catch(() => {});
    nativeAudio.command({ type: "setQuality", quality: audioRouting.musicQuality }).catch(() => {});
  }).catch((error) => notify(`Native audio host unavailable: ${error.message}`));
}

elements["project-name"].value = project.name;
renderMixtapeList();
renderLibrary();
renderTimeline();
updateHistoryButtons();
updateClipboardButtons();
refreshProviderStatus();
refreshInputDevices();
refreshOutputDevices();
updateMusicQualityUi();
elements["dub-music-monitor"].checked = audioRouting.musicMonitoring;
elements["settings-language"].value = audioRouting.language;
updateDubbingModeUi();
renderDiagnostics();
setEqCalibrationBusy(false);
updateNoiseGateUi();
setMode(appMode);
saveAudioRouting();
saveProject(true);
if (desktopStorageLoadError) notify(`Could not restore saved mixtapes: ${desktopStorageLoadError.message}`);
if (desktopSettingsLoadError) notify(`Could not restore saved settings: ${desktopSettingsLoadError.message}`);
if (desktopDiagnosticsLoadError) notify(`Could not restore diagnostic reports: ${desktopDiagnosticsLoadError.message}`);
