import { it, expect, describe } from "vitest";
import { maintainerGateOnly } from "../checks";
import {
  actionable,
  Github,
  githubItem,
  mergeItem,
  threadStatus,
} from "../core";
const message =
  'Frozen v1 entries changed. changed entries: file-gateway\nAdd the "v1-change" label if the change is intentional.';
const generic = [
  {
    annotation_level: "failure",
    message: "Process completed with exit code 1.",
  },
];
const gate = [{ name: "Run npm run gate:v1", conclusion: "failure" }];
it("recognizes gate-only logs and dedicated annotations", () => {
  expect(maintainerGateOnly({ name: "validate" }, generic, gate, message)).toBe(
    true,
  );
  expect(
    maintainerGateOnly({ name: "validate" }, [
      { annotation_level: "failure", message },
    ]),
  ).toBe(true);
  expect(
    maintainerGateOnly(
      { name: "npm run gate:v1", output: { summary: message } },
      [],
    ),
  ).toBe(true);
});
it.each([
  [gate, "Frozen v1 entries changed only"],
  [gate, 'Add the "v1-change" label only'],
  [[...gate, { name: "Validate schema", conclusion: "failure" }], message],
  [[{ name: "Validate screenshots", conclusion: "failure" }], message],
  [[], message],
])(
  "keeps incomplete evidence and other failed steps actionable",
  (steps, log) => {
    expect(
      maintainerGateOnly(
        { name: "validate" },
        generic,
        steps as any,
        log as string,
      ),
    ).toBe(false);
  },
);
it("does not hide a second concrete failure annotation beside the gate", () => {
  expect(
    maintainerGateOnly(
      { name: "validate" },
      [
        { annotation_level: "failure", message },
        { annotation_level: "failure", message: "Invalid entry schema" },
      ],
      gate,
      message,
    ),
  ).toBe(false);
});
it("quietly reconciles prior failed and idle gate items, then resurfaces a genuine error", () => {
  const first = githubItem("owner/repo", "marketplace", {
    id: 1,
    html_url: "https://github.com/get-bb/marketplace/pull/1",
  });
  const quiet = {
    ...first,
    status: "maintainer_waiting" as const,
    reason: "maintainerLabel" as const,
    fingerprint: "gate",
  };
  expect(mergeItem(first, quiet).status).toBe("maintainer_waiting");
  expect(actionable({ ...quiet, status: "new" })).toBe(false);
  expect(threadStatus(quiet, false).status).toBe("maintainer_waiting");
  expect(
    mergeItem(quiet, {
      ...first,
      reason: "checksFailed",
      fingerprint: "schema",
    }).status,
  ).toBe("new");
});
it("downloads bounded logs without forwarding a GitHub token or persisting log text", async () => {
  const calls: any[] = [];
  const stored: any[] = [];
  const api = new Github(
    "secret",
    {
      get: async () => undefined,
      set: async (k, v) => {
        stored.push([k, v]);
      },
    },
    async (input, init) => {
      calls.push({ url: String(input), headers: init?.headers });
      return calls.length === 1
        ? new Response(null, {
            status: 302,
            headers: {
              location: "https://results.blob.core.windows.net/logs/signed",
            },
          })
        : new Response(message);
    },
  );
  expect(await api.jobLog("get-bb/marketplace", "123")).toBe(message);
  expect(calls[0].headers.Authorization).toBe("Bearer secret");
  expect(calls[1].headers.Authorization).toBeUndefined();
  expect(stored).toEqual([]);
});
it("rejects oversized logs and unexpected redirect hosts", async () => {
  const make = (response: Response) =>
    new Github(
      undefined,
      { get: async () => undefined, set: async () => {} },
      async () => response,
    );
  await expect(
    make(new Response("x".repeat(2 * 1024 * 1024 + 1))).jobLog(
      "get-bb/marketplace",
      "1",
    ),
  ).rejects.toThrow("gateEvidenceUnavailable");
  await expect(
    make(
      new Response(null, {
        status: 302,
        headers: { location: "https://example.org/log" },
      }),
    ).jobLog("get-bb/marketplace", "1"),
  ).rejects.toThrow("gateEvidenceUnavailable");
});

it("keeps timeout and extra log errors visible even when the label message is present", () => {
  expect(
    maintainerGateOnly(
      { name: "validate" },
      generic,
      [{ name: "Run npm run gate:v1", conclusion: "timed_out" }],
      message,
    ),
  ).toBe(false);
  expect(
    maintainerGateOnly(
      { name: "validate" },
      generic,
      gate,
      message + "\nerror: Invalid screenshot dimensions",
    ),
  ).toBe(false);
});
