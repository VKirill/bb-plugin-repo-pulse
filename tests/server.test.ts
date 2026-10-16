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
export async function setup() {
  let h = createFakePluginHost({
    pluginId: "repo-pulse",
    experimental_callHostRpc: async (call: any) => ({ path: call.input.path }),
    sdk: {
      plugins: {
        callRpc: async (args: any) =>
          args.method === "sections_list"
            ? {
                sections: [
                  {
                    id: "parent",
                    projectId: "project",
                    hostId: "host",
                    name: "Plugins",
                    parentId: null,
                    path: "/work",
                    kind: "folder",
                  },
                  {
                    id: "folder",
                    projectId: "project",
                    hostId: "host",
                    name: "repo",
                    parentId: "parent",
                    path: "/work/repo",
                    kind: "folder",
                  },
                  {
                    id: "other",
                    projectId: "project",
                    hostId: "host",
                    name: "Other",
                    parentId: null,
                    path: "/work/other",
                    kind: "folder",
                  },
                ],
              }
            : { ok: true },
      },
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

describe("poller disposal", () => {
  it("aborts an in-flight request and never dispatches on shutdown", async () => {
    const original = globalThis.fetch;
    let started!: () => void;
    const fetched = new Promise<void>((resolve) => {
      started = resolve;
    });
    globalThis.fetch = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        started();
      });
    const h = createFakePluginHost({
      settings: { githubToken: "test-only" },
      pluginId: "repo-pulse",
    });
    try {
      await plugin(h.bb);
      await h.harness.behavior.callRpc(
        "save_config",
        configSchema.parse({
          projectId: "p",
          owner: "owner",
          repositories: ["owner/repo"],
          marketplace: false,
          automatic: true,
        }),
      );
      const service = h.harness.behavior.runService("poll");
      await fetched;
      service.controller.abort();
      await service.done;
      expect(h.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    } finally {
      globalThis.fetch = original;
      await h.harness.lifecycle.dispose();
    }
  });
});

describe("section-aware dispatch", () => {
  it("spawns at the checkout and files into the exact folder", async () => {
    const h = await setup();
    try {
      const result = (await h.harness.behavior.callRpc("run", {
        id: first.id,
        reportOnly: true,
      })) as any;
      expect(result.folderId).toBe("folder");
      const spawn = h.harness.inspection.sdk.callsTo("threads.spawn")[0] as any;
      expect(JSON.stringify(spawn)).toContain("/work/repo");
      expect(JSON.stringify(spawn)).toContain("READ-ONLY REPORT MODE");
      expect(
        JSON.stringify(h.harness.inspection.sdk.callsTo("plugins.callRpc")),
      ).toContain("thread_place");
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("refuses launch before spawn when sections are absent", async () => {
    const h = await setup();
    try {
      h.harness.sdk.stub("plugins.callRpc", async () => ({ sections: [] }));
      await expect(
        h.harness.behavior.callRpc("run", { id: first.id }),
      ).rejects.toThrow("sectionMissing");
      expect(h.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("stops a spawned agent if placement fails", async () => {
    const h = await setup();
    try {
      const original = h.bb.sdk.plugins.callRpc;
      h.harness.sdk.stub("threads.stop", async () => ({}) as any);
      h.harness.sdk.stub("plugins.callRpc", async (args: any) => {
        if (args.method === "thread_place") throw Error("failed");
        return {
          sections: [
            {
              id: "folder",
              projectId: "project",
              hostId: "host",
              name: "repo",
              parentId: null,
              path: "/work/repo",
              kind: "folder",
            },
          ],
        };
      });
      await expect(
        h.harness.behavior.callRpc("run", { id: first.id }),
      ).rejects.toThrow("placementFailed");
      expect(h.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
});

it("creates a missing section through project-folders and binds its existing checkout", async () => {
  const h = await setup();
  const rows: any[] = [
    {
      id: "parent",
      projectId: "project",
      hostId: "host",
      name: "Plugins",
      parentId: null,
      path: "/work",
      kind: "folder",
    },
  ];
  try {
    const value = (await h.harness.behavior.callRpc("config", null)) as any;
    await h.harness.behavior.callRpc("save_config", {
      ...value,
      scanRoot: "/work",
    });
    h.harness.sdk.stub("plugins.callRpc", async (args: any) => {
      if (args.method === "sections_list") return { sections: rows };
      if (args.method === "create") {
        expect(args.input).toMatchObject({
          projectId: "project",
          folderId: "parent",
          hostId: "host",
          relativePath: "/work/repo",
        });
        rows.push({
          id: "created",
          projectId: "project",
          hostId: "host",
          name: "repo",
          parentId: "parent",
          path: "/work/repo",
          kind: "folder",
        });
        return { id: "created" };
      }
      throw Error("unexpected");
    });
    const route = await h.harness.behavior.callRpc("create_section", {
      repo: "owner/repo",
    });
    expect(route).toMatchObject({
      folderId: "created",
      status: "ready",
      checkoutPath: "/work/repo",
    });
  } finally {
    await h.harness.lifecycle.dispose();
  }
});
