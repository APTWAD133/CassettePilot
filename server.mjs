import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NeteaseProvider } from "./src/netease-provider-node.js";
import {
  audioQualityFallbackLevels,
  normalizeAudioQuality,
  playbackQualityResolution
} from "./src/audio-options.js";

const apiBase = (process.env.NETEASE_API_BASE || "").replace(/\/$/, "");
const require = createRequire(import.meta.url);
let embeddedApi = null;
try {
  embeddedApi = require("@neteasecloudmusicapienhanced/api");
} catch {
  // The UI remains usable with the demo catalog when the optional provider is absent.
}
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav"
};

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function searchTypeForKind(kind) {
  if (kind === "albums") return 10;
  if (kind === "playlists") return 1000;
  return 1;
}

async function proxyNetease(response, pathname, search) {
  if (pathname === "/api/netease/detail") {
    try {
      const id = encodeURIComponent(search.get("id") || "");
      const [detailResponse, lyricResponse] = await Promise.all([
        fetch(`${apiBase}/song/detail?ids=${id}`, { headers: { accept: "application/json" } }),
        fetch(`${apiBase}/lyric?id=${id}`, { headers: { accept: "application/json" } })
      ]);
      if (!detailResponse.ok) throw new Error(`Song detail request failed (${detailResponse.status})`);
      const detail = await detailResponse.json();
      const lyric = lyricResponse.ok ? await lyricResponse.json() : {};
      const song = detail?.songs?.[0];
      if (!song) {
        json(response, 404, { code: 404, message: "Song metadata is unavailable" });
        return;
      }
      json(response, 200, {
        code: 200,
        song: {
          id: String(song.id),
          title: song.name || "Untitled track",
          artist: (song.ar || song.artists || []).map((artist) => artist.name).join(", ") || "Unknown artist",
          album: song.al?.name || song.album?.name || "Unknown album",
          coverUrl: song.al?.picUrl || song.album?.picUrl || "",
          durationMs: song.dt || song.duration || 0
        },
        lyrics: lyric?.lrc?.lyric || "",
        translatedLyrics: lyric?.tlyric?.lyric || ""
      });
    } catch (error) {
      json(response, 502, { error: "NetEase provider request failed", detail: error.message });
    }
    return;
  }

  if (pathname === "/api/netease/url") {
    try {
      const body = await externalSongUrl(search.get("id") || "", search.get("level"));
      json(response, firstPlayableStatus(body), body);
    } catch (error) {
      json(response, 502, { error: "NetEase provider request failed", detail: error.message });
    }
    return;
  }

  const targetPath = `/search?keywords=${encodeURIComponent(search.get("q") || "")}&limit=20&type=${searchTypeForKind(search.get("kind"))}`;

  try {
    const upstream = await fetch(`${apiBase}${targetPath}`, {
      headers: { accept: "application/json" }
    });
    const body = await upstream.arrayBuffer();
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json"
    });
    response.end(Buffer.from(body));
  } catch (error) {
    json(response, 502, { error: "NetEase provider request failed", detail: error.message });
  }
}

async function externalSongUrl(id, level) {
  const requested = normalizeAudioQuality(level);
  let lastBody = { code: 404, data: [] };
  for (const attempted of audioQualityFallbackLevels(requested)) {
    const upstream = await fetch(
      `${apiBase}/song/url/v1?id=${encodeURIComponent(id)}&level=${attempted}`,
      { headers: { accept: "application/json" } }
    );
    if (!upstream.ok) continue;
    const body = await upstream.json();
    lastBody = body;
    const item = body?.data?.find?.((candidate) => candidate?.url);
    if (item) return {
      ...body,
      resolution: playbackQualityResolution(requested, attempted, item)
    };
  }
  return {
    ...lastBody,
    message: lastBody.message || "No playable URL is available for this account and track."
  };
}

async function embeddedNetease(provider, response, pathname, search) {
  if (!provider) {
    json(response, 503, {
      error: "NetEase API Enhanced is not installed",
      hint: "Run npm install and restart the app."
    });
    return;
  }

  try {
    if (pathname === "/api/netease/status") {
      json(response, 200, provider.status);
      return;
    }
    if (pathname === "/api/netease/search") {
      json(response, 200, await provider.search(
        search.get("q") || "",
        20,
        searchTypeForKind(search.get("kind"))
      ));
      return;
    }
    if (pathname === "/api/netease/collection") {
      const body = await provider.collection(search.get("kind") || "", search.get("id") || "");
      json(response, body.code === 200 ? 200 : body.code === 400 ? 400 : 404, body);
      return;
    }
    if (pathname === "/api/netease/detail") {
      const body = await provider.songInfo(search.get("id") || "");
      json(response, body.code === 200 ? 200 : 404, body);
      return;
    }
    if (pathname === "/api/netease/url") {
      const body = await provider.songUrl(search.get("id") || "", normalizeAudioQuality(search.get("level")));
      json(response, firstPlayableStatus(body), body);
      return;
    }
    if (pathname === "/api/netease/login/qr/start") {
      json(response, 200, await provider.createQrLogin());
      return;
    }
    if (pathname === "/api/netease/login/qr/check") {
      json(response, 200, await provider.checkQrLogin(search.get("key") || ""));
      return;
    }
    if (pathname === "/api/netease/logout") {
      await provider.signOut();
      json(response, 200, provider.status);
      return;
    }
    json(response, 404, { error: "Unknown NetEase route" });
  } catch (error) {
    json(response, 502, {
      error: "NetEase API Enhanced request failed",
      detail: error?.message || error?.body?.msg || String(error)
    });
  }
}

function firstPlayableStatus(body) {
  return body?.data?.some?.((item) => item?.url) ? 200 : 404;
}

async function resolveNeteaseStreamUrl(provider, search) {
  const id = search.get("id") || "";
  const level = normalizeAudioQuality(search.get("level"));
  if (apiBase) {
    const body = await externalSongUrl(id, level);
    return body?.data?.find?.((item) => item?.url)?.url || "";
  }
  if (!provider) return "";
  const body = await provider.songUrl(id, level);
  return body?.data?.find?.((item) => item?.url)?.url || "";
}

export async function pipeAudioStream(request, response, target) {
  const targetUrl = new URL(target);
  if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
    throw new Error("Unsupported audio stream URL");
  }
  const headers = {};
  if (request.headers.range) headers.range = request.headers.range;
  const upstream = await fetch(targetUrl, { headers });
  const responseHeaders = {};
  for (const name of ["accept-ranges", "content-length", "content-range", "content-type"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders[name] = value;
  }
  responseHeaders["cache-control"] = "no-store";
  response.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) {
    response.end();
    return;
  }
  await pipeline(Readable.fromWeb(upstream.body), response);
}

async function streamNeteaseAudio(provider, request, response, search) {
  try {
    const target = await resolveNeteaseStreamUrl(provider, search);
    if (!target) {
      json(response, 404, { error: "No playable NetEase URL is available" });
      return;
    }
    await pipeAudioStream(request, response, target);
  } catch (error) {
    if (!response.headersSent) {
      json(response, 502, { error: "NetEase audio stream failed", detail: error.message });
    } else if (!response.destroyed) {
      // A CDN or client can end an audio range request after the headers have
      // already been sent. Close only this media response; passing the error to
      // ServerResponse would surface it as an uncaught Electron main-process
      // exception instead of a recoverable HTMLMediaElement network error.
      response.destroy();
    }
  }
}

export function startCassetteServer({
  port = Number(process.env.PORT || 4173),
  host = "127.0.0.1",
  root = process.cwd(),
  providerCookie = process.env.NETEASE_COOKIE || "",
  onProviderCookieChanged = null
} = {}) {
  const staticRoot = resolve(root);
  const provider = embeddedApi
    ? new NeteaseProvider(embeddedApi, {
        cookie: providerCookie,
        onCookieChanged: onProviderCookieChanged
      })
    : null;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (url.pathname === "/api/netease/stream") {
      await streamNeteaseAudio(provider, request, response, url.searchParams);
      return;
    }

    if (url.pathname.startsWith("/api/netease/")) {
      if (apiBase && ["/api/netease/search", "/api/netease/url", "/api/netease/detail"].includes(url.pathname)) {
        await proxyNetease(response, url.pathname, url.searchParams);
      } else {
        await embeddedNetease(provider, response, url.pathname, url.searchParams);
      }
      return;
    }

    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const filePath = normalize(join(staticRoot, requested));
    const relativePath = filePath.slice(staticRoot.length);
    if (!filePath.startsWith(staticRoot) || (relativePath && !relativePath.startsWith("\\") && !relativePath.startsWith("/"))) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error("Not a file");
      const body = await readFile(filePath);
      response.writeHead(200, {
        "content-type": types[extname(filePath)] || "application/octet-stream",
        "cache-control": "no-store"
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });

  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const activePort = typeof address === "object" && address ? address.port : port;
      console.log(`CassettePilot running at http://${host}:${activePort}`);
      if (apiBase) {
        console.log(`NetEase provider: external service at ${apiBase}`);
      } else if (provider) {
        console.log(`NetEase provider: API Enhanced embedded (${provider.status.authenticated ? "authenticated" : "QR login available"})`);
      } else {
        console.log("NetEase provider disabled. Run npm install or set NETEASE_API_BASE.");
      }
      resolveServer(server);
    });
  });
}

const launchedFromCommandLine = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (launchedFromCommandLine) {
  startCassetteServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
