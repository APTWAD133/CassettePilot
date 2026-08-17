import { ZH_CN_MESSAGES, ZH_CN_PATTERNS } from "./locales/zh-CN.js";

export const SUPPORTED_LOCALES = Object.freeze(["en", "zh-CN"]);

const textSources = new WeakMap();
const attributeSources = new WeakMap();
const TRANSLATABLE_ATTRIBUTES = ["aria-label", "title", "placeholder", "alt"];
let activeLocale = "en";
let observer = null;

export function normalizeLocale(value) {
  return value === "zh-CN" || String(value || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function interpolate(value, params) {
  return String(value).replace(/\{(\w+)\}/g, (match, key) => key in params ? params[key] : match);
}

export function translateText(source, locale = activeLocale) {
  const normalized = normalizeLocale(locale);
  if (normalized === "en" || typeof source !== "string") return source;
  const exact = ZH_CN_MESSAGES[source];
  if (exact) return exact;
  for (const [pattern, replacement] of ZH_CN_PATTERNS) {
    if (pattern.test(source)) return source.replace(pattern, replacement);
  }
  return source;
}

export function t(source, params = {}, locale = activeLocale) {
  return translateText(interpolate(source, params), locale);
}

function translatedNodeValue(source, locale = activeLocale) {
  const match = source.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!match || !match[2]) return source;
  return `${match[1]}${translateText(match[2], locale)}${match[3]}`;
}

function localizeTextNode(node) {
  const parent = node.parentElement;
  if (!parent || parent.closest("script, style, [data-i18n-ignore]")) return;
  const current = node.data;
  const previousSource = textSources.get(node);
  const matchesPreviousRendering = previousSource && SUPPORTED_LOCALES.some((locale) =>
    translatedNodeValue(previousSource, locale) === current
  );
  if (!matchesPreviousRendering) textSources.set(node, current);
  const source = textSources.get(node);
  const translated = translatedNodeValue(source);
  if (node.data !== translated) node.data = translated;
}

function localizeAttributes(element) {
  if (!(element instanceof Element) || element.closest("[data-i18n-ignore]")) return;
  let sources = attributeSources.get(element);
  if (!sources) {
    sources = {};
    attributeSources.set(element, sources);
  }
  for (const attribute of TRANSLATABLE_ATTRIBUTES) {
    if (!element.hasAttribute(attribute)) continue;
    const current = element.getAttribute(attribute);
    const previousSource = sources[attribute];
    const matchesPreviousRendering = previousSource && SUPPORTED_LOCALES.some((locale) =>
      translateText(previousSource, locale) === current
    );
    if (!matchesPreviousRendering) sources[attribute] = current;
    const translated = translateText(sources[attribute]);
    if (current !== translated) element.setAttribute(attribute, translated);
  }
}

function localizeNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    localizeTextNode(node);
    return;
  }
  if (!(node instanceof Element) && node !== document) return;
  if (node instanceof Element) localizeAttributes(node);
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let current;
  while ((current = walker.nextNode())) {
    if (current.nodeType === Node.TEXT_NODE) localizeTextNode(current);
    else localizeAttributes(current);
  }
}

export function localizeDocument(root = document) {
  document.documentElement.lang = activeLocale;
  localizeNode(root);
}

export function setLocale(locale, root = document) {
  activeLocale = normalizeLocale(locale);
  localizeDocument(root);
  window.dispatchEvent(new CustomEvent("cassette-language-changed", { detail: { locale: activeLocale } }));
  return activeLocale;
}

export function getLocale() {
  return activeLocale;
}

export function observeLocalization(root = document.body) {
  observer?.disconnect();
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") localizeTextNode(mutation.target);
      if (mutation.type === "attributes") localizeAttributes(mutation.target);
      mutation.addedNodes.forEach(localizeNode);
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: TRANSLATABLE_ATTRIBUTES
  });
  localizeDocument(root);
  return () => observer?.disconnect();
}
