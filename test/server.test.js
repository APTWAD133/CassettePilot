import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { pipeAudioStream, startCassetteServer } from "../server.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("desktop server selects an available loopback port and serves the packaged root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cassettepilot-"));
  await writeFile(join(root, "index.html"), "portable-ready", "utf8");
  const server = await startCassetteServer({ port: 0, root });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.ok(address.port > 0);

  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "portable-ready");
});

test("desktop server restores and clears a persisted provider login", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cassettepilot-auth-"));
  const credentialChanges = [];
  const server = await startCassetteServer({
    port: 0,
    root,
    providerCookie: "MUSIC_U=persisted",
    onProviderCookieChanged(cookie) {
      credentialChanges.push(cookie);
    }
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const restored = await fetch(`${origin}/api/netease/status`).then((response) => response.json());
  assert.equal(restored.authenticated, true);

  const loggedOut = await fetch(`${origin}/api/netease/logout`).then((response) => response.json());
  assert.equal(loggedOut.authenticated, false);
  assert.deepEqual(credentialChanges, [""]);
});

test("local audio streaming preserves range responses for media seeking", async (t) => {
  const audio = Buffer.from("0123456789");
  const upstream = createServer((request, response) => {
    assert.equal(request.headers.range, "bytes=2-5");
    response.writeHead(206, {
      "accept-ranges": "bytes",
      "content-range": "bytes 2-5/10",
      "content-length": "4",
      "content-type": "audio/mpeg"
    });
    response.end(audio.subarray(2, 6));
  });
  const upstreamOrigin = await listen(upstream);
  const proxy = createServer((request, response) => {
    pipeAudioStream(request, response, `${upstreamOrigin}/track.mp3`).catch((error) => response.destroy(error));
  });
  const proxyOrigin = await listen(proxy);
  t.after(async () => {
    await Promise.all([
      new Promise((resolve) => proxy.close(resolve)),
      new Promise((resolve) => upstream.close(resolve))
    ]);
  });

  const response = await fetch(`${proxyOrigin}/audio`, { headers: { range: "bytes=2-5" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal(await response.text(), "2345");
});

test("a terminated upstream audio stream rejects cleanly instead of escaping asynchronously", async (t) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, {
      "content-length": "100",
      "content-type": "audio/mpeg"
    });
    response.write("partial-audio");
    response.socket.destroy();
  });
  const upstreamOrigin = await listen(upstream);
  let capturedError = null;
  const proxy = createServer(async (request, response) => {
    try {
      await pipeAudioStream(request, response, `${upstreamOrigin}/broken.mp3`);
    } catch (error) {
      capturedError = error;
      if (!response.destroyed) response.destroy();
    }
  });
  const proxyOrigin = await listen(proxy);
  t.after(async () => {
    await Promise.all([
      new Promise((resolve) => proxy.close(resolve)),
      new Promise((resolve) => upstream.close(resolve))
    ]);
  });

  await assert.rejects(fetch(`${proxyOrigin}/audio`));
  assert.ok(capturedError instanceof Error);
});
