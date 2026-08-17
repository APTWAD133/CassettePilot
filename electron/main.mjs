import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, safeStorage, session, shell } from "electron";
import { appendFile, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { startCassetteServer } from "../server.mjs";
import { createQueuedJsonWriter, readJsonFile } from "./json-store.mjs";

let mainWindow = null;
let localServer = null;
let localOrigin = "";
let suspensionBlockerId = null;
let nativeAudioHost = null;
let nativeAudioReady = false;
let nativeAudioEvents = [];
let transitionLogPath = "";
const providerCredentialFilename = "netease-credential.bin";
const mixtapeStoreFilename = "mixtapes-v1.json";
const settingsFilename = "settings-v1.json";
const diagnosticsFilename = "diagnostics-v1.json";
let writeMixtapeStore = null;
let writeSettings = null;
let writeDiagnostics = null;

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

const portableDirectory = process.env.PORTABLE_EXECUTABLE_DIR;
if (portableDirectory) {
  app.setPath("userData", join(portableDirectory, "CassettePilot Data"));
}

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
}

function isTrustedAppUrl(candidate) {
  try {
    return new URL(candidate).origin === localOrigin;
  } catch {
    return false;
  }
}

function configurePermissions() {
  const allowedPermissions = new Set(["media", "speaker-selection"]);

  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const origin = details?.requestingUrl || requestingOrigin;
    if (!isTrustedAppUrl(origin) || !allowedPermissions.has(permission)) return false;
    if (permission === "media" && details?.mediaType === "video") return false;
    return true;
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = details?.requestingUrl || webContents.getURL();
    const allowed = isTrustedAppUrl(origin)
      && allowedPermissions.has(permission)
      && !(permission === "media" && details?.mediaTypes?.includes?.("video"));
    callback(allowed);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: "#0b0e0b",
    autoHideMenuBar: true,
    title: "CassettePilot",
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(import.meta.dirname, "preload.cjs")
    }
  });
  mainWindow.webContents.setBackgroundThrottling(false);
  transitionLogPath = join(app.getPath("userData"), "cassette-transition.log");
  mainWindow.webContents.on("console-message", (_event, detailsOrLevel, legacyMessage) => {
    const message = typeof detailsOrLevel === "object"
      ? detailsOrLevel?.message
      : legacyMessage;
    if (!message?.startsWith("[tape]")) return;
    void appendFile(transitionLogPath, `${new Date().toISOString()} ${message}\n`, "utf8");
  });
  void appendFile(transitionLogPath, `\n${new Date().toISOString()} [desktop] session-start 0.1.0 native-wasapi\n`, "utf8");

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isTrustedAppUrl(url)) return;
    event.preventDefault();
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(localOrigin);
}

function nativeHostPath() {
  return app.isPackaged
    ? join(process.resourcesPath, "native", "CassettePilot.AudioHost.exe")
    : join(app.getAppPath(), "native", "publish", "CassettePilot.AudioHost.exe");
}

function forwardNativeEvent(payload) {
  nativeAudioEvents.push(payload);
  if (nativeAudioEvents.length > 20) nativeAudioEvents.shift();
  if (payload?.type === "ready") nativeAudioReady = true;
  if (transitionLogPath && ["inputStarted", "pipeline", "carrier", "error"].includes(payload?.type)) {
    void appendFile(
      transitionLogPath,
      `${new Date().toISOString()} [native] ${JSON.stringify(payload)}\n`,
      "utf8"
    );
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("cassette-native:event", payload);
}

function launchNativeAudioHost() {
  const executable = nativeHostPath();
  nativeAudioHost = spawn(executable, ["--api-base", localOrigin], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: nativeAudioHost.stdout });
  lines.on("line", (line) => {
    try { forwardNativeEvent(JSON.parse(line)); }
    catch { forwardNativeEvent({ type: "error", scope: "native-protocol", message: line }); }
  });
  nativeAudioHost.stderr.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (message) forwardNativeEvent({ type: "error", scope: "native-host", message });
  });
  nativeAudioHost.on("error", (error) => {
    nativeAudioReady = false;
    forwardNativeEvent({ type: "error", scope: "native-host", message: error.message });
  });
  nativeAudioHost.on("exit", (code) => {
    nativeAudioReady = false;
    nativeAudioHost = null;
    if (code && !app.isQuitting) forwardNativeEvent({ type: "error", scope: "native-host", message: `Native audio host exited (${code})` });
  });
}

function sendNativeCommand(command) {
  if (!nativeAudioHost?.stdin?.writable) throw new Error("Native Windows audio host is not running");
  nativeAudioHost.stdin.write(`${JSON.stringify(command)}\n`);
  return { accepted: true };
}

async function loadProviderCookie() {
  if (!safeStorage.isEncryptionAvailable()) return "";
  const credentialPath = join(app.getPath("userData"), providerCredentialFilename);
  try {
    return safeStorage.decryptString(await readFile(credentialPath));
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("Could not restore the encrypted NetEase login.", error?.message || error);
    return "";
  }
}

async function persistProviderCookie(cookie) {
  const credentialPath = join(app.getPath("userData"), providerCredentialFilename);
  if (!cookie) {
    try { await unlink(credentialPath); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn("Windows credential encryption is unavailable; the NetEase login will last for this session only.");
    return;
  }
  await writeFile(credentialPath, safeStorage.encryptString(cookie), { mode: 0o600 });
}

function validateMixtapeStore(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.items)) {
    throw new Error("Invalid mixtape collection");
  }
  return value;
}

function mixtapeStorePath() {
  return join(app.getPath("userData"), mixtapeStoreFilename);
}

async function loadMixtapeStore() {
  const value = await readJsonFile(mixtapeStorePath());
  return value === null ? null : validateMixtapeStore(value);
}

function persistMixtapeStore(value) {
  validateMixtapeStore(value);
  writeMixtapeStore ||= createQueuedJsonWriter(mixtapeStorePath());
  return writeMixtapeStore(value).then(() => ({ saved: true }));
}

function validateSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid application settings");
  }
  return value;
}

function settingsPath() {
  return join(app.getPath("userData"), settingsFilename);
}

async function loadSettings() {
  const value = await readJsonFile(settingsPath());
  return value === null ? null : validateSettings(value);
}

function persistSettings(value) {
  validateSettings(value);
  writeSettings ||= createQueuedJsonWriter(settingsPath(), { maxBytes: 64 * 1024 });
  return writeSettings(value).then(() => ({ saved: true }));
}

function validateDiagnostics(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.reports)) {
    throw new Error("Invalid diagnostic report collection");
  }
  return value;
}

function diagnosticsPath() {
  return join(app.getPath("userData"), diagnosticsFilename);
}

async function loadDiagnostics() {
  const value = await readJsonFile(diagnosticsPath());
  return value === null ? null : validateDiagnostics(value);
}

function persistDiagnostics(value) {
  validateDiagnostics(value);
  writeDiagnostics ||= createQueuedJsonWriter(diagnosticsPath(), { maxBytes: 512 * 1024 });
  return writeDiagnostics(value).then(() => ({ saved: true }));
}

async function startApplication() {
  suspensionBlockerId = powerSaveBlocker.start("prevent-app-suspension");
  const providerCookie = await loadProviderCookie();
  localServer = await startCassetteServer({
    port: 0,
    host: "127.0.0.1",
    root: app.getAppPath(),
    providerCookie,
    onProviderCookieChanged: persistProviderCookie
  });
  const address = localServer.address();
  if (!address || typeof address === "string") {
    throw new Error("The local application server did not expose a TCP port.");
  }
  localOrigin = `http://127.0.0.1:${address.port}`;
  launchNativeAudioHost();
  configurePermissions();
  createWindow();
}

if (hasInstanceLock) {
  ipcMain.handle("cassette-storage:load-mixtapes", loadMixtapeStore);
  ipcMain.handle("cassette-storage:save-mixtapes", (_event, value) => persistMixtapeStore(value));
  ipcMain.handle("cassette-storage:load-settings", loadSettings);
  ipcMain.handle("cassette-storage:save-settings", (_event, value) => persistSettings(value));
  ipcMain.handle("cassette-storage:load-diagnostics", loadDiagnostics);
  ipcMain.handle("cassette-storage:save-diagnostics", (_event, value) => persistDiagnostics(value));
  ipcMain.handle("cassette-native:command", (_event, command) => sendNativeCommand(command));
  ipcMain.handle("cassette-native:get-state", () => {
    if (transitionLogPath) void appendFile(transitionLogPath, `${new Date().toISOString()} [desktop] native-bridge-ready\n`, "utf8");
    return { ready: nativeAudioReady, events: nativeAudioEvents };
  });
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(startApplication).catch((error) => {
    dialog.showErrorBox(
      "CassettePilot could not start",
      error?.stack || error?.message || String(error)
    );
    app.quit();
  });
}

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  if (nativeAudioHost?.stdin?.writable) {
    try { nativeAudioHost.stdin.write('{"type":"shutdown"}\n'); } catch { }
  }
  const host = nativeAudioHost;
  setTimeout(() => { if (host && !host.killed) host.kill(); }, 1_000).unref();
  localServer?.close();
  localServer = null;
  if (suspensionBlockerId !== null && powerSaveBlocker.isStarted(suspensionBlockerId)) {
    powerSaveBlocker.stop(suspensionBlockerId);
  }
  suspensionBlockerId = null;
});
