import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { encodeWav, generateSignal, SIGNAL } from "../src/signal.js";

const project = "native/CassettePilot.AudioHost/CassettePilot.AudioHost.csproj";
const host = resolve(
  "native/CassettePilot.AudioHost/bin/Release/net8.0-windows/win-x64/CassettePilot.AudioHost.dll"
);

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: resolve("."),
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit"
  });
  if (capture && result.stdout) process.stdout.write(result.stdout);
  if (capture && result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed`);
  return result.stdout || "";
}

function lastEvent(output, type) {
  const events = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const event = events.findLast((item) => item.type === type);
  assert.ok(event, `${type} event was not emitted`);
  return event;
}

const samples = generateSignal(SIGNAL.frameDurationMs * 4, (timelineMs, sequence) => ({
  version: 2,
  flags: 1,
  sequence,
  timelineMs,
  trackId: "32194496",
  sourceMs: 12_000 + timelineMs,
  gainDb: -4.5,
  gainTargetTimelineMs: timelineMs + 1_000,
  gainTargetDb: -2,
  nextTrackId: "18795454"
}));

function stretchChannel(channel, ratio) {
  const output = new Float32Array(Math.floor(channel.length * ratio));
  for (let index = 0; index < output.length; index += 1) {
    const source = index / ratio;
    const before = Math.floor(source);
    const after = Math.min(channel.length - 1, before + 1);
    const fraction = source - before;
    output[index] = channel[before] + (channel[after] - channel[before]) * fraction;
  }
  return output;
}

const tapeSpeedRatio = 1.004;
const stretchedSamples = {
  left: stretchChannel(samples.left, tapeSpeedRatio),
  right: stretchChannel(samples.right, tapeSpeedRatio)
};

const temporaryDirectory = await mkdtemp(join(tmpdir(), "cassette-native-pipeline-"));
const fixture = join(temporaryDirectory, "fixture.wav");
const stretchedFixture = join(temporaryDirectory, "fixture-stretched.wav");
try {
  await writeFile(fixture, Buffer.from(encodeWav(samples)));
  await writeFile(stretchedFixture, Buffer.from(encodeWav(stretchedSamples)));
  run("dotnet", ["build", project, "-c", "Release"]);

  const resampler = lastEvent(
    run("dotnet", [host, "--self-test-pipeline"], { capture: true }),
    "pipelineSelfTestComplete"
  );
  assert.equal(resampler.passed, true);

  const carrier = lastEvent(
    run("dotnet", [host, "--self-test-carrier"], { capture: true }),
    "carrierTestComplete"
  );
  assert.equal(carrier.passed, true);

  const continuous = lastEvent(
    run("dotnet", [host, "--verify-live-pipeline", fixture], { capture: true }),
    "pipelineTestComplete"
  );
  assert.equal(continuous.frames, 4);
  assert.equal(continuous.discontinuities, 0);
  assert.ok(continuous.realtimeRatio < 1, `pipeline ran at ${continuous.realtimeRatio}x real time`);

  const fractionalSpeed = lastEvent(
    run("dotnet", [host, "--verify-live-pipeline", stretchedFixture], { capture: true }),
    "pipelineTestComplete"
  );
  assert.ok(fractionalSpeed.frames >= 3, `only ${fractionalSpeed.frames} fractional-speed frames decoded`);
  assert.equal(fractionalSpeed.discontinuities, 0);
  assert.ok(fractionalSpeed.realtimeRatio < 1, `fractional-speed pipeline ran at ${fractionalSpeed.realtimeRatio}x real time`);

  const recovered = lastEvent(
    run("dotnet", [host, "--verify-live-pipeline", fixture, "--drop-block", "8"], { capture: true }),
    "pipelineTestComplete"
  );
  assert.ok(recovered.frames >= 2, `only ${recovered.frames} frames decoded after a dropped block`);
  assert.equal(recovered.discontinuities, 1);
  assert.ok(recovered.realtimeRatio < 1, `recovery ran at ${recovered.realtimeRatio}x real time`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
