import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function createQueuedJsonWriter(filePath, { maxBytes = 16 * 1024 * 1024 } = {}) {
  let queue = Promise.resolve();

  return function writeJson(value) {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
      return Promise.reject(new Error("Saved data is too large"));
    }

    queue = queue.catch(() => {}).then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      await writeFile(temporaryPath, serialized, "utf8");
      await rename(temporaryPath, filePath);
    });
    return queue;
  };
}
