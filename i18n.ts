import { useEffect, useState } from "react";
import { en, ru } from "./messages";
export { en, ru } from "./messages";
export type Locale = "en" | "ru";
export function resolveLocale(input: {
  lang?: string;
  pk?: string | null;
  preference?: string | null;
  russifier?: string | null;
  labels?: string[];
}): Locale {
  if (input.lang?.toLowerCase().startsWith("ru")) return "ru";
  if (input.preference === "ru" || input.preference === "en")
    return input.preference;
  if (input.russifier === "off") return "en";
  if (input.pk === "ru") return "ru";
  return input.labels?.some((label) =>
    /^(Назад|Вперёд|Переключить боковую панель|Показать правую панель|Новый тред)/.test(
      label,
    ),
  )
    ? "ru"
    : "en";
}
export function detectLocale(): Locale {
  if (typeof document === "undefined") return "en";
  let preference: string | null = null,
    russifier: string | null = null;
  try {
    preference = localStorage.getItem("pokecut-theme:locale");
    russifier = localStorage.getItem("bb-plugin-ru:enabled");
  } catch {}
  return resolveLocale({
    lang: document.documentElement.lang,
    pk: document.documentElement.getAttribute("data-pk-lang"),
    preference,
    russifier,
    labels: [
      ...document.querySelectorAll(
        '[data-sidebar="sidebar"] button[aria-label],header button[aria-label]',
      ),
    ]
      .slice(0, 30)
      .map((x) => x.getAttribute("aria-label") ?? ""),
  });
}
export function strings() {
  return detectLocale() === "ru" ? ru : en;
}
export function observeLocale(listener: () => void): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["lang", "data-pk-lang", "aria-label"],
  });
  window.addEventListener("storage", listener);
  window.addEventListener("pokecut-theme:locale", listener);
  return () => {
    observer.disconnect();
    window.removeEventListener("storage", listener);
    window.removeEventListener("pokecut-theme:locale", listener);
  };
}
export function useStrings() {
  const [value, setValue] = useState(strings);
  useEffect(() => {
    const sync = () => setValue(strings());
    const dispose = observeLocale(sync);
    sync();
    return dispose;
  }, []);
  return value;
}
export function errorText(error: unknown, t: typeof en): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes("\n"))
    return raw
      .split("\n")
      .map((line) => errorText(new Error(line), t))
      .join("\n");
  const key = Object.keys(en).find((k) => raw === k || raw.endsWith(": " + k));
  if (key) {
    const prefix = raw === key ? "" : raw.slice(0, -key.length);
    return prefix + t[key as keyof typeof en];
  }
  const http = raw.match(/GitHub HTTP (\d+)/);
  if (http) return `${t.githubError} (${http[1]})`;
  if (error instanceof SyntaxError || /validation|JSON|Zod/i.test(raw))
    return t.invalidSettings;
  if (/fetch|network|timeout|abort/i.test(raw)) return t.networkError;
  return t.error;
}
/** SDK metadata is plain text. Localize only our own host-owned labels, never other plugins or GitHub content. */
export function mountChromeLocalization() {
  const pairs = ([en.title, en.description] as string[]).map((text, i) => [
    text,
    [ru.title, ru.description][i],
  ]);
  let scheduled = false,
    disposed = false;
  function sync() {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (disposed) return;
      const t = strings();
      const currentPairs =
        location.pathname === "/settings/plugins/repo-pulse"
          ? [...pairs, [en.token, ru.token], [en.secretLabel, ru.secretLabel]]
          : pairs;
      const translate = (text: string) => {
        for (const [english, russian] of currentPairs)
          if (text === english || text === russian)
            return t === ru ? russian : english;
        return text;
      };
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
      );
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (
          node.parentElement?.closest(
            "[data-rp-content],script,style,textarea,pre",
          )
        )
          continue;
        const value = node.nodeValue ?? "";
        const next = translate(value.trim());
        if (next !== value.trim())
          node.nodeValue = value.replace(value.trim(), next);
      }
      for (const el of document.querySelectorAll("[aria-label],[title]"))
        for (const attr of ["aria-label", "title"]) {
          const value = el.getAttribute(attr);
          if (value) {
            const next = translate(value);
            if (next !== value) el.setAttribute(attr, next);
          }
        }
    });
  }
  const observer = new MutationObserver(sync);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-label", "title"],
  });
  const unsub = observeLocale(sync);
  sync();
  return () => {
    disposed = true;
    observer.disconnect();
    unsub();
  };
}
