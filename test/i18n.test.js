import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLocale, t, translateText } from "../src/i18n.js";

test("language values normalize to supported application locales", () => {
  assert.equal(normalizeLocale("en"), "en");
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale("zh-CN"), "zh-CN");
  assert.equal(normalizeLocale("zh-Hans"), "zh-CN");
  assert.equal(normalizeLocale("fr"), "en");
});

test("Simplified Chinese translates fixed interface messages", () => {
  assert.equal(translateText("Tape Monitor", "zh-CN"), "磁带监视器");
  assert.equal(translateText("System default input", "zh-CN"), "系统默认输入");
  assert.equal(translateText("Control signal preloaded - ready to start recording", "zh-CN"), "控制信号已预加载 · 可以立即开始录制");
  assert.equal(translateText("Clear preloaded audio?", "zh-CN"), "清除预加载音频？");
  assert.equal(translateText("Tape Monitor", "en"), "Tape Monitor");
});

test("dynamic interface messages preserve user data and values", () => {
  assert.equal(translateText("Switched to side B", "zh-CN"), "已切换到 B 面");
  assert.equal(translateText("Preload music · side A", "zh-CN"), "预加载音乐 · A 面");
  assert.equal(translateText("Start recording · side B", "zh-CN"), "开始录制 · B 面");
  assert.equal(translateText("My Road Tape opened", "zh-CN"), "已打开 My Road Tape");
  assert.equal(t("{count} tracks", { count: 12 }, "en"), "12 tracks");
  assert.equal(t("{count} tracks", { count: 12 }, "zh-CN"), "12 首歌曲");
});

test("missing translations fall back to English source text", () => {
  assert.equal(translateText("Untranslated future feature", "zh-CN"), "Untranslated future feature");
});
