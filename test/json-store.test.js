import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createQueuedJsonWriter, readJsonFile } from "../electron/json-store.mjs";

test("desktop JSON storage survives reads and keeps the newest queued save", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cassette-json-store-"));
  const filePath = join(directory, "mixtapes.json");
  t.after(() => rm(directory, { recursive: true, force: true }));

  assert.equal(await readJsonFile(filePath), null);
  const writeJson = createQueuedJsonWriter(filePath);
  await Promise.all([
    writeJson({ activeId: "first", items: [{ id: "first" }] }),
    writeJson({ activeId: "newest", items: [{ id: "newest" }] })
  ]);

  assert.deepEqual(await readJsonFile(filePath), {
    activeId: "newest",
    items: [{ id: "newest" }]
  });
});

test("desktop JSON storage rejects oversized data without replacing the last save", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cassette-json-limit-"));
  const filePath = join(directory, "mixtapes.json");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const writeJson = createQueuedJsonWriter(filePath, { maxBytes: 64 });
  await writeJson({ activeId: "safe", items: [] });
  await assert.rejects(() => writeJson({ items: [{ name: "x".repeat(100) }] }), /too large/);
  assert.deepEqual(await readJsonFile(filePath), { activeId: "safe", items: [] });
});
