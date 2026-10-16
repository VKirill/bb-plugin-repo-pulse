import { it, expect } from "vitest";
import {
  ownerDecision,
  analysisPrompt,
  completion,
  decisionPrompt,
} from "../workflow";
import { configSchema, githubItem } from "../core";
const item = githubItem("owner/repo", "issue", {
  id: 1,
  number: 1,
  user: { login: "helper" },
  html_url: "https://github.com/owner/repo/issues/1",
});
it.each([
  ["внедряй", "implement"],
  ["вариант 2", "implement"],
  ["Внедрить.", "implement"],
  ["не надо", "reject"],
  ["Отклонить", "reject"],
  ["А можно вариант 2?", null],
  ["Пока не внедряй", null],
])("recognizes only explicit owner decisions: %s", (text, decision) =>
  expect(ownerDecision(text!)).toBe(decision),
);
it("enforces analysis even for a custom autonomous contract and automatic mode", () => {
  const p = analysisPrompt(
    configSchema.parse({ prompt: "Implement immediately", automatic: true }),
    [item],
    "/work/repo",
  );
  expect(p.startsWith("REPO PULSE — STAGE 1: ANALYSIS ONLY")).toBe(true);
  expect(p).toContain("no file changes");
  expect(p).toContain("In Russian");
  expect(p).toContain("English draft reply");
  expect(p).toContain("Do not implement your own recommendation");
});
it("scopes continuation and a rejection separately, and accepts only exact completion lines", () => {
  expect(
    decisionPrompt(
      configSchema.parse({}),
      [item],
      "/work/repo",
      "implement",
      "вариант 2",
    ),
  ).toContain("OWNER DECISION — STAGE 2: IMPLEMENT");
  expect(
    decisionPrompt(configSchema.parse({}), [item], "/work/repo", "reject", ""),
  ).toContain("No code changes");
  expect(completion("Готово\nREPO_PULSE_RESULT: done")).toBe("done");
  expect(completion("REPO_PULSE_RESULT: rejected")).toBe("rejected");
  expect(completion("quoted REPO_PULSE_RESULT: done")).toBeUndefined();
});
