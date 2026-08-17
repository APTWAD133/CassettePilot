import test from "node:test";
import assert from "node:assert/strict";
import { NeteaseProvider } from "../src/netease-provider-node.js";

test("provider searches through the enhanced API contract", async () => {
  let received;
  const provider = new NeteaseProvider({
    async search(query) {
      received = query;
      return { body: { code: 200, result: { songs: [{ id: 1 }] } } };
    }
  });
  const result = await provider.search("晴天", 12);
  assert.equal(result.result.songs[0].id, 1);
  assert.equal(received.keywords, "晴天");
  assert.equal(received.limit, 12);
  assert.equal(received.type, 1);
});

test("provider forwards album and playlist search types", async () => {
  const receivedTypes = [];
  const provider = new NeteaseProvider({
    async search(query) {
      receivedTypes.push(query.type);
      return { body: { code: 200, result: {} } };
    }
  });
  await provider.search("In Rainbows", 20, 10);
  await provider.search("Road trip", 20, 1000);
  assert.deepEqual(receivedTypes, [10, 1000]);
});

test("provider enriches search results with cover artwork", async () => {
  const provider = new NeteaseProvider({
    async search() {
      return { body: { code: 200, result: { songs: [{ id: 1, name: "Reckoner" }] } } };
    },
    async song_detail({ ids }) {
      assert.equal(ids, "1");
      return { body: { songs: [{ id: 1, al: { name: "In Rainbows", picUrl: "https://image.test/in-rainbows.jpg" } }] } };
    }
  });
  const result = await provider.search("Reckoner");
  assert.equal(result.result.songs[0].al.picUrl, "https://image.test/in-rainbows.jpg");
});

test("provider combines song detail, cover art, album, and lyrics", async () => {
  const provider = new NeteaseProvider({
    async song_detail() {
      return { body: { songs: [{
        id: 186016,
        name: "晴天",
        ar: [{ name: "周杰伦" }],
        al: { name: "叶惠美", picUrl: "https://image.test/cover.jpg" },
        dt: 269_000
      }] } };
    },
    async lyric() {
      return { body: { lrc: { lyric: "[00:01.00]第一句" }, tlyric: { lyric: "[00:01.00]Line one" } } };
    }
  });
  const result = await provider.songInfo("186016");
  assert.equal(result.song.album, "叶惠美");
  assert.equal(result.song.coverUrl, "https://image.test/cover.jpg");
  assert.match(result.lyrics, /第一句/);
  assert.match(result.translatedLyrics, /Line one/);
});

test("provider normalizes albums and complete playlists with track artwork", async () => {
  const provider = new NeteaseProvider({
    async album() {
      return { body: {
        album: { id: 10, name: "In Rainbows", artist: { name: "Radiohead" }, picUrl: "https://image.test/album.jpg" },
        songs: [{ id: 1, name: "Reckoner", ar: [{ name: "Radiohead" }], al: { name: "In Rainbows" }, dt: 290_000 }]
      } };
    },
    async playlist_detail() {
      return { body: { playlist: { id: 20, name: "Night Drive", creator: { nickname: "Listener" }, coverImgUrl: "https://image.test/playlist.jpg", tracks: [] } } };
    },
    async playlist_track_all() {
      return { body: { songs: [{ id: 2, name: "Track two", ar: [{ name: "Artist" }], al: { name: "Album", picUrl: "https://image.test/track.jpg" }, dt: 180_000 }] } };
    }
  });
  const album = await provider.collection("album", "10");
  assert.equal(album.collection.coverUrl, "https://image.test/album.jpg");
  assert.equal(album.tracks[0].coverUrl, "https://image.test/album.jpg");
  const playlist = await provider.collection("playlist", "20");
  assert.equal(playlist.collection.subtitle, "Listener");
  assert.equal(playlist.tracks[0].coverUrl, "https://image.test/track.jpg");
});

test("provider paginates playlists beyond the song-detail limit", async () => {
  const offsets = [];
  const provider = new NeteaseProvider({
    async playlist_detail() {
      return { body: { playlist: {
        id: 20,
        name: "Long playlist",
        trackIds: Array.from({ length: 1001 }, (_, id) => ({ id: id + 1 })),
        tracks: []
      } } };
    },
    async playlist_track_all({ offset, limit }) {
      offsets.push(offset);
      const count = Math.min(limit, 1001 - offset);
      return { body: { songs: Array.from({ length: count }, (_, index) => ({
        id: offset + index + 1,
        name: `Track ${offset + index + 1}`,
        dt: 1_000
      })) } };
    }
  });
  const playlist = await provider.collection("playlist", "20");
  assert.deepEqual(offsets, [0, 500, 1000]);
  assert.equal(playlist.tracks.length, 1001);
});

test("playback falls back from v1 to the legacy URL endpoint", async () => {
  const provider = new NeteaseProvider({
    async song_url_v1() {
      throw new Error("xeapi public key is missing");
    },
    async song_url() {
      return { body: { code: 200, data: [{ id: 186016, url: "https://audio.test/song.mp3" }] } };
    }
  });
  const result = await provider.songUrl("186016");
  assert.equal(result.data[0].url, "https://audio.test/song.mp3");
});

test("playback forwards the selected quality and maps it for the legacy fallback", async () => {
  const requests = [];
  const provider = new NeteaseProvider({
    async song_url_v1(query) {
      requests.push(["v1", query.level]);
      throw new Error("v1 unavailable");
    },
    async song_url(query) {
      requests.push(["legacy", query.br]);
      return { body: { code: 200, data: [{ id: 186016, url: "https://audio.test/song.mp3" }] } };
    }
  });
  await provider.songUrl("186016", "higher");
  assert.deepEqual(requests, [["v1", "higher"], ["v1", "standard"], ["legacy", 192_000]]);
});

test("playback falls through unavailable VIP tiers and reports the granted quality", async () => {
  const requests = [];
  const provider = new NeteaseProvider({
    async song_url_v1(query) {
      requests.push(query.level);
      if (query.level !== "lossless") return { body: { code: 200, data: [{ id: 1, url: null }] } };
      return {
        body: {
          code: 200,
          data: [{ id: 1, url: "https://audio.test/lossless.flac", level: "lossless", br: 999_000 }]
        }
      };
    },
    async song_url() {
      throw new Error("legacy should not be needed");
    }
  });
  const result = await provider.songUrl("1", "best");
  assert.deepEqual(requests, ["jymaster", "hires", "lossless"]);
  assert.equal(result.data[0].url, "https://audio.test/lossless.flac");
  assert.deepEqual(result.resolution, {
    requested: "best",
    attempted: "lossless",
    actual: "lossless",
    fallback: false,
    bitrate: 999_000
  });
});

test("provider-reported quality downgrades are visible to the client", async () => {
  const provider = new NeteaseProvider({
    async song_url_v1() {
      return {
        body: {
          code: 200,
          data: [{ id: 1, url: "https://audio.test/320.mp3", level: "exhigh", br: 320_000 }]
        }
      };
    }
  });
  const result = await provider.songUrl("1", "jymaster");
  assert.equal(result.resolution.actual, "exhigh");
  assert.equal(result.resolution.fallback, true);
});

test("playback never requests a cross-service unblock", async () => {
  let unblockCalls = 0;
  const api = {
    async song_url_v1(query) {
      if (query.unblock === "true") {
        unblockCalls += 1;
        return { body: { code: 200, data: [{ id: 1, url: "https://audio.test/fallback.mp3" }] } };
      }
      throw new Error("missing key");
    },
    async song_url() {
      return { body: { code: 200, data: [{ id: 1, url: null }] } };
    }
  };
  const provider = new NeteaseProvider(api, { allowUnblock: true });
  const unavailable = await provider.songUrl("1");
  assert.equal(unavailable.data[0].url, null);
  assert.equal(unblockCalls, 0);
});

test("QR login reports credential changes without exposing the cookie", async () => {
  const credentialChanges = [];
  const provider = new NeteaseProvider({
    async login_qr_key() {
      return { body: { data: { code: 200, unikey: "qr-key" }, code: 200 } };
    },
    async login_qr_create() {
      return { body: { code: 200, data: { qrurl: "https://music.163.com/login", qrimg: "data:image/png;base64,abc" } } };
    },
    async login_qr_check() {
      return { body: { code: 803, message: "Authorized", cookie: "MUSIC_U=secret" } };
    }
  }, {
    onCookieChanged(cookie) {
      credentialChanges.push(cookie);
    }
  });
  const qr = await provider.createQrLogin();
  assert.equal(qr.key, "qr-key");
  assert.match(qr.qrimg, /^data:image\/png/);
  const check = await provider.checkQrLogin(qr.key);
  assert.equal(check.authenticated, true);
  assert.equal(provider.status.authenticated, true);
  assert.equal("cookie" in check, false);
  assert.deepEqual(credentialChanges, ["MUSIC_U=secret"]);
  await provider.signOut();
  assert.equal(provider.status.authenticated, false);
  assert.deepEqual(credentialChanges, ["MUSIC_U=secret", ""]);
});

test("credential persistence failures do not desynchronize provider state", async () => {
  const loginProvider = new NeteaseProvider({
    async login_qr_check() {
      return { body: { code: 803, cookie: "MUSIC_U=secret" } };
    }
  }, {
    async onCookieChanged() {
      throw new Error("credential store unavailable");
    }
  });
  await assert.rejects(loginProvider.checkQrLogin("qr-key"), /credential store unavailable/);
  assert.equal(loginProvider.status.authenticated, false);

  const logoutProvider = new NeteaseProvider({}, {
    cookie: "MUSIC_U=existing",
    async onCookieChanged() {
      throw new Error("credential delete failed");
    }
  });
  await assert.rejects(logoutProvider.signOut(), /credential delete failed/);
  assert.equal(logoutProvider.status.authenticated, true);
});
