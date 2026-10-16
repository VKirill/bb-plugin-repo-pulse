import { it, expect, describe } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import {
  actionable,
  isBot,
  marketplaceRepo,
  installedRepo,
  configSchema,
  githubItem,
} from "../core";
import { DEFAULT_CONTRACT, LEGACY_CONTRACT } from "../agent-contract";

it("separates dependency bots, calm marketplace waiting and muted/disabled items from action", () => {
  const item = githubItem("owner/repo", "issue", {
    id: 1,
    number: 1,
    user: { login: "helper" },
    html_url: "https://github.com/owner/repo/issues/1",
  });
  expect(actionable(item)).toBe(true);
  for (const author of [
    "dependabot[bot]",
    "renovate[bot]",
    "github-actions[bot]",
  ]) {
    expect(isBot(author)).toBe(true);
    expect(actionable({ ...item, author })).toBe(false);
  }
  expect(actionable({ ...item, status: "marketplace_waiting" })).toBe(false);
  expect(actionable({ ...item, ignored: true })).toBe(false);
  expect(actionable({ ...item, status: "muted" })).toBe(false);
  expect(
    actionable({ ...item, kind: "ci", author: "github-actions", bot: false }),
  ).toBe(true);
});
it("maps marketplace entry to source repo and fails closed for unrelated or ambiguous entries", () => {
  expect(
    marketplaceRepo(
      [
        {
          source: {
            git: {
              url: "https://github.com/VKirill/bb-plugin-file-gateway.git",
            },
          },
        },
      ],
      "VKirill",
    ),
  ).toBe("VKirill/bb-plugin-file-gateway");
  expect(() => marketplaceRepo([], "VKirill")).toThrow("marketplaceUnmapped");
  expect(() =>
    marketplaceRepo(
      [{ source: { git: { url: "https://github.com/other/repo" } } }],
      "VKirill",
    ),
  ).toThrow();
  expect(
    installedRepo(
      { id: "agency", source: "path:/hub/bb-plugin-agency" },
      "VKirill",
      ["VKirill/bb-plugin-agency"],
    ),
  ).toBe("VKirill/bb-plugin-agency");
  expect(
    installedRepo(
      {
        id: "file-gateway",
        source:
          "git:https://github.com/VKirill/bb-plugin-file-gateway.git@semver:^0.1.0",
      },
      "VKirill",
      [],
    ),
  ).toBe("VKirill/bb-plugin-file-gateway");
});

it("migrates only the shipped contract, preserving custom contracts", async () => {
  let h = createFakePluginHost({
    pluginId: "repo-pulse",
    sdk: { plugins: { list: async () => ({ plugins: [] }) } },
  });
  try {
    await h.bb.storage.kv.set(
      "config",
      configSchema.parse({ prompt: LEGACY_CONTRACT }),
    );
    await plugin(h.bb);
    expect(
      ((await h.harness.behavior.callRpc("config", null)) as any).prompt,
    ).toBe(DEFAULT_CONTRACT);
    await h.harness.behavior.callRpc(
      "save_config",
      configSchema.parse({ prompt: "custom" }),
    );
    h = await h.harness.lifecycle.reload(plugin);
    expect(
      ((await h.harness.behavior.callRpc("config", null)) as any).prompt,
    ).toBe("custom");
  } finally {
    await h.harness.lifecycle.dispose();
  }
});

describe("marketplace collector policy", () => {
  it("groups own PR under plugin, waits quietly, surfaces maintainer feedback/check failures, skips disabled repositories", async () => {
    const original = globalThis.fetch;
    let feedback = false,
      failed = false,
      closed = false,
      enabled = false;
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      const row = {
        id: 12,
        number: 42,
        title: "Update test",
        state: closed ? "closed" : "open",
        user: { login: "owner" },
        html_url: "https://github.com/get-bb/marketplace/pull/42",
        updated_at: "2026-10-16",
      };
      let data: any = [];
      if (url.pathname === "/search/issues")
        data = { items: closed ? [] : [row] };
      else if (url.pathname === "/repos/get-bb/marketplace/issues/42")
        data = row;
      else if (url.pathname.endsWith("/pulls/42"))
        data = {
          head: { sha: "commit", repo: { full_name: "owner/marketplace" } },
        };
      else if (url.pathname.endsWith("/pulls/42/files"))
        data = [{ filename: "entries/test.json" }];
      else if (url.pathname.endsWith("/contents/entries/test.json"))
        data = {
          encoding: "base64",
          content: Buffer.from(
            JSON.stringify({
              source: {
                git: { url: "https://github.com/owner/bb-plugin-test.git" },
              },
            }),
          ).toString("base64"),
        };
      else if (url.pathname.endsWith("/check-runs"))
        data = { check_runs: [{ conclusion: failed ? "failure" : "success" }] };
      else if (url.pathname.endsWith("/status")) data = { state: "pending" };
      else if (url.pathname.endsWith("/issues/42/comments"))
        data = feedback
          ? [
              {
                id: 13,
                user: { login: "maintainer" },
                html_url: row.html_url + "#issuecomment-13",
                updated_at: "2026-10-17",
              },
            ]
          : [];
      else if (url.pathname === "/repos/owner/bb-plugin-test")
        data = { default_branch: "main" };
      else if (url.pathname.endsWith("/actions/runs"))
        data = { workflow_runs: [] };
      return new Response(JSON.stringify(data), {
        headers: { "x-ratelimit-remaining": "4000" },
      });
    };
    const h = createFakePluginHost({
      pluginId: "repo-pulse",
      settings: { githubToken: "test" },
      sdk: {
        plugins: {
          list: async () => ({
            plugins: [
              {
                id: "test",
                enabled,
                source:
                  "git:https://github.com/owner/bb-plugin-test.git@^0.1.0",
              } as any,
            ],
          }),
        },
      },
    });
    try {
      await plugin(h.bb);
      await h.harness.behavior.callRpc(
        "save_config",
        configSchema.parse({
          owner: "owner",
          repositories: ["owner/bb-plugin-test"],
        }),
      );
      let result: any = await h.harness.behavior.callRpc("refresh", null);
      expect(result.errors).toEqual([]);
      expect(result.count).toBe(0);
      expect(result.items[0]).toMatchObject({
        repo: "owner/bb-plugin-test",
        sourceRepo: "get-bb/marketplace",
        status: "marketplace_waiting",
        ignored: true,
      });
      expect(requests).not.toContain("/repos/owner/bb-plugin-test/issues");
      enabled = true;
      result = await h.harness.behavior.callRpc("refresh", null);
      expect(result.count).toBe(0);
      feedback = true;
      result = await h.harness.behavior.callRpc("refresh", null);
      expect(result.count).toBe(1);
      expect(result.items.find((i: any) => i.kind === "comment")).toMatchObject(
        { repo: "owner/bb-plugin-test", sourceRepo: "get-bb/marketplace" },
      );
      failed = true;
      result = await h.harness.behavior.callRpc("refresh", null);
      expect(result.count).toBe(2);
      failed = false;
      result = await h.harness.behavior.callRpc("refresh", null);
      expect(result.count).toBe(1);
      closed = true;
      result = await h.harness.behavior.callRpc("refresh", null);
      expect(result.count).toBe(0);
      expect(result.items.every((i: any) => i.closed)).toBe(true);
    } finally {
      globalThis.fetch = original;
      await h.harness.lifecycle.dispose();
    }
  });
});

it("resolves overview-only marketplace changes by plugin id or title without guessing across plugins", () => {
  const aliases = [
    {
      repo: "VKirill/bb-plugin-cli-agents",
      names: ["cli-agents", "CLI Agents"],
    },
  ];
  expect(
    marketplaceRepo([], "VKirill", {
      files: ["overview/cli-agents.md"],
      title: "Documentation",
      aliases,
    }),
  ).toBe(aliases[0].repo);
  expect(
    marketplaceRepo([], "VKirill", {
      files: [],
      title: "Update CLI Agents description",
      aliases,
    }),
  ).toBe(aliases[0].repo);
  expect(() =>
    marketplaceRepo([], "VKirill", {
      files: [],
      title: "Update unrelated documentation",
      aliases,
    }),
  ).toThrow("marketplaceUnmapped");
});
