import assert from "node:assert/strict";
import { createServer } from "node:http";
import { app, BrowserWindow, powerSaveBlocker, session } from "electron";

app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

function createWave(durationSeconds = 8, sampleRate = 8_000) {
  const sampleCount = durationSeconds * sampleRate;
  const buffer = Buffer.alloc(44 + sampleCount * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.sin(index / sampleRate * Math.PI * 2 * 220) * 0.02;
    buffer.writeInt16LE(Math.round(sample * 32_767), 44 + index * 2);
  }
  return buffer;
}

function sendWave(request, response, wave) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || "");
  const start = match ? Number(match[1]) : 0;
  const requestedEnd = match?.[2] ? Number(match[2]) : wave.length - 1;
  const end = Math.min(wave.length - 1, requestedEnd);
  const headers = {
    "accept-ranges": "bytes",
    "content-length": end - start + 1,
    "content-type": "audio/wav"
  };
  if (match) headers["content-range"] = `bytes ${start}-${end}/${wave.length}`;
  response.writeHead(match ? 206 : 200, headers);
  response.end(wave.subarray(start, end + 1));
}

async function startMediaServer() {
  const wave = createWave();
  const server = createServer((request, response) => {
    if (request.url === "/track-a.wav" || request.url === "/track-b.wav") {
      sendWave(request, response, wave);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Background media test</title>");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

function withMainTimeout(promise, milliseconds, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds))
  ]);
}

async function run() {
  const blockerId = powerSaveBlocker.start("prevent-app-suspension");
  const mediaServer = await startMediaServer();
  const address = mediaServer.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    requestingOrigin.startsWith(origin) && ["media", "speaker-selection"].includes(permission)
  );
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) =>
    callback(contents.getURL().startsWith(origin) && ["media", "speaker-selection"].includes(permission))
  );
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  await window.loadURL(origin);
  await window.webContents.executeJavaScript(`(async () => {
    window.backgroundStats = { animationFrames: 0, timerTicks: 0, workerTicks: 0 };
    const animate = () => {
      window.backgroundStats.animationFrames += 1;
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
    setInterval(() => { window.backgroundStats.timerTicks += 1; }, 50);
    const workerSource = 'setInterval(() => postMessage(1), 50)';
    const worker = new Worker(URL.createObjectURL(new Blob([workerSource])));
    worker.onmessage = () => { window.backgroundStats.workerTicks += 1; };

    window.prepareBackgroundTrack = async (url, attach = true) => {
      const withTimeout = (promise, label) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out')), 5_000))
      ]);
      const audio = new Audio(url);
      audio.preload = 'auto';
      audio.muted = true;
      audio.volume = 0;
      audio.loop = true;
      if (attach) document.body.append(audio);
      const outputs = (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === 'audiooutput');
      const output = outputs.find((device) => device.deviceId !== 'default') || outputs[0];
      const startedAt = performance.now();
      if (typeof audio.setSinkId === 'function') {
        await withTimeout(audio.setSinkId(output?.deviceId || ''), 'setSinkId');
      }
      const routedAt = performance.now();
      await withTimeout(audio.play(), 'play');
      return { audio, routeMs: routedAt - startedAt, playMs: performance.now() - routedAt };
    };
    window.firstTrack = await window.prepareBackgroundTrack('/track-a.wav');
  })()`);

  window.showInactive();
  window.minimize();
  const transition = await withMainTimeout(window.webContents.executeJavaScript(`(async () => {
    const prepared = await window.prepareBackgroundTrack('/track-b.wav', false);
    prepared.audio.muted = true;
    prepared.audio.currentTime = 2;
    prepared.audio.loop = false;
    prepared.audio.muted = false;
    window.secondTrack = prepared;
    return { routeMs: prepared.routeMs, playMs: prepared.playMs };
  })()`), 8_000, "background media preparation");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const result = await window.webContents.executeJavaScript(`({
    visibilityState: document.visibilityState,
    ...window.backgroundStats,
    secondTrack: {
      currentTime: window.secondTrack.audio.currentTime,
      paused: window.secondTrack.audio.paused,
      readyState: window.secondTrack.audio.readyState,
      seeking: window.secondTrack.audio.seeking,
      ...${JSON.stringify(transition)}
    }
  })`);

  assert.equal(result.visibilityState, "visible");
  assert.ok(result.animationFrames > 20, `animation frames stalled: ${result.animationFrames}`);
  assert.ok(result.timerTicks > 15, `renderer timers stalled: ${result.timerTicks}`);
  assert.ok(result.workerTicks > 15, `worker messages stalled: ${result.workerTicks}`);
  assert.equal(result.secondTrack.paused, false);
  assert.ok(result.secondTrack.readyState >= 2, `media was not ready: ${result.secondTrack.readyState}`);
  assert.ok(result.secondTrack.currentTime > 3, `background track did not advance: ${result.secondTrack.currentTime}`);
  console.log(JSON.stringify(result));

  window.destroy();
  await new Promise((resolve) => mediaServer.close(resolve));
  if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
  app.quit();
}

app.whenReady().then(run).catch((error) => {
  console.error(error);
  app.exit(1);
});
