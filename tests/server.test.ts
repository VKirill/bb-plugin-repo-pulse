import { describe, it, expect } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { configSchema, githubItem } from "../core";
const first = githubItem("owner/repo", "issue", {
  id: 1,
  number: 1,
  title: "Issue",
  user: { login: "a" },
  html_url: "https://github.com/owner/repo/issues/1",
  updated_at: "2026-10-16",
});
async function setup() {
  let h = createFakePluginHost({
    pluginId: "repo-pulse",
    sdk: {
      threads: {
        spawn: async () => ({ id: "thr_safe" }) as any,
        get: async () =>
          makeThreadResponse({ id: "thr_safe", status: "active" }),
      },
    },
  });
  await plugin(h.bb);
  await h.harness.behavior.callRpc(
    "save_config",
    configSchema.parse({
      projectId: "project",
      hostId: "host",
      checkouts: { "owner/repo": "/work/repo" },
    }),
  );
  await h.bb.storage.kv.set("item:" + first.id, first);
  h = await h.harness.lifecycle.reload(plugin);
  return h;
}
describe("dispatch lifecycle", () => {
  it("validates dry run without spawning a thread", async () => {
    const h = await setup();
    const result = await h.harness.behavior.callRpc("run", {
      id: first.id,
      dryRun: true,
    });
    expect(result).toMatchObject({
      threadId: null,
      checkoutPath: "/work/repo",
    });
    expect(h.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    await h.harness.lifecycle.dispose();
  });
  it("groups items, prevents a second repository writer, and follows idle", async () => {
    let h = await setup();
    const second = {
      ...first,
      id: "owner/repo:comment:2",
      kind: "comment" as const,
    };
    await h.bb.storage.kv.set("item:" + second.id, second);
    h = await h.harness.lifecycle.reload(plugin);
    await h.harness.behavior.callRpc("batch", null);
    expect(h.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    await expect(
      h.harness.behavior.callRpc("run", { id: first.id }),
    ).rejects.toThrow("repoBusy");
    await h.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_safe", status: "idle" }),
      lastAssistantText: "done",
    });
    const data = (await h.harness.behavior.callRpc("list", null)) as any;
    expect(data.items.map((i: any) => i.status)).toEqual([
      "waiting",
      "waiting",
    ]);
    await h.harness.lifecycle.dispose();
  });
  it("keeps auto mode disabled by default and installs one background poller", async () => {
    const h = await setup();
    expect(configSchema.parse({}).automatic).toBe(false);
    expect(h.harness.registrations.services).toHaveLength(1);
    await h.harness.lifecycle.dispose();
  });
});

describe("collector integration", () => {
  it("persists new comments, consumes ETags, and resolves only explicit closures", async () => {
    const original = globalThis.fetch;
    let closed = false;
    const headers: Record<string, string>[] = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      headers.push(init?.headers as Record<string, string>);
      let data: unknown = [];
      const row = {
        id: 7,
        number: 1,
        title: "External issue",
        state: closed ? "closed" : "open",
        user: { login: "helper" },
        html_url: "https://github.com/owner/repo/issues/1",
        updated_at: closed ? "2026-10-17" : "2026-10-16",
      };
      if (url.pathname === "/repos/owner/repo/issues")
        data = closed ? [] : [row];
      else if (url.pathname === "/repos/owner/repo/issues/1") data = row;
      else if (url.pathname === "/repos/owner/repo/issues/1/comments")
        data = [
          {
            id: 9,
            user: { login: "helper" },
            html_url: "https://github.com/owner/repo/issues/1#issuecomment-9",
            updated_at: "2026-10-16",
          },
        ];
      else if (url.pathname === "/repos/owner/repo")
        data = { default_branch: "main" };
      else if (url.pathname.endsWith("/actions/runs"))
        data = { workflow_runs: [] };
      return new Response(JSON.stringify(data), {
        headers: { etag: '"test"', "x-ratelimit-remaining": "4990" },
      });
    };
    const h = createFakePluginHost({
      settings: { githubToken: "test-only" },
      pluginId: "repo-pulse",
    });
    try {
      await plugin(h.bb);
      await h.harness.behavior.callRpc(
        "save_config",
        configSchema.parse({
          owner: "owner",
          repositories: ["owner/repo"],
          marketplace: false,
        }),
      );
      const first = (await h.harness.behavior.callRpc("refresh", null)) as any;
      expect(first.count).toBe(2);
      expect(first.authenticated).toBe(true);
      expect(first.errors).toEqual([]);
      const second = (await h.harness.behavior.callRpc("refresh", null)) as any;
      expect(second.count).toBe(2);
      expect(headers.some((h) => h["If-None-Match"] === '"test"')).toBe(true);
      closed = true;
      const third = (await h.harness.behavior.callRpc("refresh", null)) as any;
      expect(third.items.every((i: any) => i.status === "done")).toBe(true);
      expect(third.count).toBe(0);
    } finally {
      globalThis.fetch = original;
      await h.harness.lifecycle.dispose();
    }
  });
});
