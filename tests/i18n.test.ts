// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  en,
  ru,
  resolveLocale,
  strings,
  errorText,
  mountChromeLocalization,
} from "../i18n";
afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.lang = "en";
  document.documentElement.removeAttribute("data-pk-lang");
  localStorage.clear();
});
describe("complete interface localization", () => {
  it("has identical EN and RU dictionary keys", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
  });
  it.each([
    { lang: "ru-RU" },
    { lang: "en", pk: "ru" },
    { lang: "en", labels: ["Назад"] },
    { lang: "en", preference: "ru" },
  ])("detects Russian BB signals %o", (input) => {
    expect(resolveLocale(input)).toBe("ru");
  });
  it("keeps English as default and respects disabled russifier", () => {
    expect(resolveLocale({ lang: "en" })).toBe("en");
    expect(
      resolveLocale({ lang: "en", russifier: "off", labels: ["Назад"] }),
    ).toBe("en");
  });
  it("localizes errors without leaking raw English SDK errors", () => {
    expect(errorText(Error("sectionMissing"), ru)).toBe(ru.sectionMissing);
    expect(errorText(Error("rpc input validation failed"), ru)).toBe(
      ru.invalidSettings,
    );
    expect(errorText(Error("unexpected backend error"), ru)).toBe(ru.error);
  });
  it("localizes live host-owned navigation, header and plugin list metadata", async () => {
    document.documentElement.setAttribute("data-pk-lang", "ru");
    document.body.innerHTML = `<button aria-label="${en.title}">${en.title}</button><p>${en.description}</p><main data-rp-content><p>${en.title}</p></main>`;
    const stop = mountChromeLocalization();
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.querySelector("button")?.textContent).toBe(ru.title);
      expect(document.querySelector("button")?.getAttribute("aria-label")).toBe(
        ru.title,
      );
      expect(document.querySelector("body>p")?.textContent).toBe(
        ru.description,
      );
      expect(document.querySelector("main p")?.textContent).toBe(en.title);
      expect(strings()).toBe(ru);
    } finally {
      stop();
    }
  });
  it("has no user-facing JSX text or labels outside the dictionary", () => {
    const violations: string[] = [];
    for (const filename of ["app.tsx", "repository-sections.tsx"]) {
      const source = ts.createSourceFile(
        filename,
        readFileSync(filename, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      function walk(node: ts.Node) {
        if (ts.isJsxText(node) && /[A-Za-zА-Яа-яЁё]/.test(node.getText()))
          violations.push(filename + ": " + node.getText());
        if (
          ts.isJsxAttribute(node) &&
          ["aria-label", "title", "placeholder"].includes(
            node.name.getText(),
          ) &&
          node.initializer &&
          ts.isStringLiteral(node.initializer) &&
          /[A-Za-zА-Яа-яЁё]/.test(node.initializer.text)
        )
          violations.push(filename + ": " + node.getText());
        ts.forEachChild(node, walk);
      }
      walk(source);
    }
    expect(violations).toEqual([]);
  });
});
