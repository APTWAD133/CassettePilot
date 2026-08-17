import {
  audioQualityFallbackLevels,
  legacyBitrateForQuality,
  normalizeAudioQuality,
  playbackQualityResolution
} from "./audio-options.js";

function bodyOf(result) {
  return result?.body ?? result ?? {};
}

function firstPlayable(body) {
  const item = body?.data?.[0];
  return item?.url ? item : null;
}

function resolvedPlaybackBody(body, requestedQuality, attemptedQuality) {
  const item = firstPlayable(body);
  return item ? {
    ...body,
    resolution: playbackQualityResolution(requestedQuality, attemptedQuality, item)
  } : body;
}

function normalizeTrack(song, fallbackCoverUrl = "") {
  return {
    neteaseId: String(song.id),
    title: song.name || "Untitled track",
    artist: (song.ar || song.artists || []).map((artist) => artist.name).join(", ") || "Unknown artist",
    album: song.al?.name || song.album?.name || "Unknown album",
    coverUrl: song.al?.picUrl || song.album?.picUrl || fallbackCoverUrl,
    durationMs: song.dt || song.duration || 180_000
  };
}

export class NeteaseProvider {
  constructor(api, options = {}) {
    this.api = api;
    this.cookie = options.cookie || "";
    this.onCookieChanged = typeof options.onCookieChanged === "function"
      ? options.onCookieChanged
      : null;
  }

  get status() {
    return {
      available: Boolean(this.api),
      authenticated: Boolean(this.cookie),
      mode: "embedded"
    };
  }

  async search(query, limit = 20, type = 1) {
    const result = await this.api.search({
      keywords: query,
      limit,
      type,
      cookie: this.cookie || undefined,
      timestamp: Date.now()
    });
    const body = bodyOf(result);
    if (Number(type) !== 1) return body;
    const songs = Array.isArray(body?.result?.songs) ? body.result.songs : [];
    const missingArtwork = songs.filter((song) => !(song.al?.picUrl || song.album?.picUrl));
    if (!missingArtwork.length || typeof this.api.song_detail !== "function") return body;

    try {
      const detailsResult = await this.api.song_detail({
        ids: missingArtwork.map((song) => song.id).join(","),
        cookie: this.cookie || undefined,
        timestamp: Date.now()
      });
      const details = bodyOf(detailsResult)?.songs || [];
      const detailsById = new Map(details.map((song) => [String(song.id), song]));
      return {
        ...body,
        result: {
          ...body.result,
          songs: songs.map((song) => {
            const detail = detailsById.get(String(song.id));
            if (!detail) return song;
            return {
              ...song,
              al: detail.al || song.al,
              album: detail.album || song.album,
              ar: detail.ar || song.ar,
              artists: detail.artists || song.artists,
              dt: detail.dt || song.dt,
              duration: detail.duration || song.duration
            };
          })
        }
      };
    } catch {
      return body;
    }
  }

  async collection(kind, id) {
    const common = {
      id: String(id),
      cookie: this.cookie || undefined,
      timestamp: Date.now()
    };
    if (kind === "album") {
      const result = bodyOf(await this.api.album(common));
      const album = result?.album;
      if (!album) return { code: 404, message: "Album metadata is unavailable" };
      const coverUrl = album.picUrl || album.blurPicUrl || "";
      return {
        code: 200,
        collection: {
          id: String(album.id || id),
          kind,
          title: album.name || "Untitled album",
          subtitle: (album.artists || [album.artist]).filter(Boolean).map((artist) => artist.name).join(", ") || "Unknown artist",
          coverUrl
        },
        tracks: (result.songs || []).map((song) => normalizeTrack(song, coverUrl))
      };
    }
    if (kind === "playlist") {
      const detail = bodyOf(await this.api.playlist_detail({ ...common, s: 0 }));
      const playlist = detail?.playlist;
      if (!playlist) return { code: 404, message: "Playlist metadata is unavailable" };
      let songs = playlist.tracks || [];
      if (typeof this.api.playlist_track_all === "function") {
        try {
          const trackCount = playlist.trackIds?.length || playlist.trackCount || songs.length;
          const pageSize = 500;
          const collected = [];
          for (let offset = 0; offset < Math.max(1, trackCount); offset += pageSize) {
            const page = bodyOf(await this.api.playlist_track_all({ ...common, limit: pageSize, offset }));
            if (!Array.isArray(page.songs) || !page.songs.length) break;
            collected.push(...page.songs);
            if (page.songs.length < pageSize) break;
          }
          if (collected.length) songs = collected;
        } catch {
          // The detail response still contains a useful partial track list.
        }
      }
      const coverUrl = playlist.coverImgUrl || "";
      return {
        code: 200,
        collection: {
          id: String(playlist.id || id),
          kind,
          title: playlist.name || "Untitled playlist",
          subtitle: playlist.creator?.nickname || "NetEase playlist",
          coverUrl
        },
        tracks: songs.map((song) => normalizeTrack(song, coverUrl))
      };
    }
    return { code: 400, message: "Unsupported collection type" };
  }

  async songInfo(id) {
    const common = {
      cookie: this.cookie || undefined,
      timestamp: Date.now()
    };
    const [detailResult, lyricResult] = await Promise.allSettled([
      this.api.song_detail({ ids: String(id), ...common }),
      this.api.lyric({ id: String(id), ...common })
    ]);
    if (detailResult.status === "rejected") throw detailResult.reason;
    const detail = bodyOf(detailResult.value);
    const lyric = lyricResult.status === "fulfilled" ? bodyOf(lyricResult.value) : {};
    const song = detail?.songs?.[0];
    if (!song) return { code: 404, message: "Song metadata is unavailable" };
    return {
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
    };
  }

  async songUrl(id, level = "best") {
    const quality = normalizeAudioQuality(level);
    const attempts = audioQualityFallbackLevels(quality);
    const providerErrors = [];
    let lastBody = { code: 404, data: [] };

    for (const attempted of attempts) {
      try {
        const result = await this.api.song_url_v1({
          id,
          level: attempted,
          cookie: this.cookie || undefined,
          timestamp: Date.now()
        });
        const body = bodyOf(result);
        lastBody = body;
        if (firstPlayable(body)) return resolvedPlaybackBody(body, quality, attempted);
      } catch (error) {
        providerErrors.push(error?.message || String(error));
      }
    }

    const legacyAttempts = [];
    const legacyBitrates = new Set();
    for (const attempted of attempts) {
      const bitrate = legacyBitrateForQuality(attempted);
      if (legacyBitrates.has(bitrate)) continue;
      legacyBitrates.add(bitrate);
      legacyAttempts.push({ attempted, bitrate });
    }
    for (const attempt of legacyAttempts) {
      try {
        const legacy = await this.api.song_url({
          id,
          br: attempt.bitrate,
          cookie: this.cookie || undefined,
          timestamp: Date.now()
        });
        const body = bodyOf(legacy);
        lastBody = body;
        if (firstPlayable(body)) return resolvedPlaybackBody(body, quality, attempt.attempted);
      } catch (error) {
        providerErrors.push(error?.message || String(error));
      }
    }

    return {
      code: lastBody.code || 404,
      data: lastBody.data || [],
      message: this.cookie
        ? "No playable URL is available for this account and track."
        : "Sign in to NetEase Cloud Music to request a playable URL.",
      providerError: providerErrors[0] || null
    };
  }

  async createQrLogin() {
    const keyResult = await this.api.login_qr_key({ timestamp: Date.now() });
    const keyBody = bodyOf(keyResult);
    const key = keyBody?.data?.unikey || keyBody?.data?.data?.unikey;
    if (!key) throw new Error("NetEase did not return a QR login key");

    const qrResult = await this.api.login_qr_create({
      key,
      qrimg: true,
      timestamp: Date.now()
    });
    const qrBody = bodyOf(qrResult);
    return {
      key,
      qrurl: qrBody?.data?.qrurl || "",
      qrimg: qrBody?.data?.qrimg || ""
    };
  }

  async checkQrLogin(key) {
    const result = await this.api.login_qr_check({
      key,
      timestamp: Date.now(),
      noCookie: true
    });
    const body = bodyOf(result);
    if (body.code === 803 && body.cookie) {
      await this.onCookieChanged?.(body.cookie);
      this.cookie = body.cookie;
    }
    return {
      code: body.code,
      message: body.message || body.msg || "",
      authenticated: Boolean(this.cookie)
    };
  }

  async signOut() {
    await this.onCookieChanged?.("");
    this.cookie = "";
  }
}
