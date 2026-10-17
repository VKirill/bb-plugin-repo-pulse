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
        list: async () => ({ plugins: [] }),
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
      "awaiting_decision",
      "awaiting_decision",
    ]);
    await h.harness.lifecycle.dispose();
  });
  it("keeps auto mode disabled by default and installs a startup guard and one native schedule", async () => {
    const h = await setup();
    expect(configSchema.parse({}).automatic).toBe(false);
    expect(h.harness.registrations.services).toHaveLength(1);
    expect(h.harness.registrations.schedules).toHaveLength(1);
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
      sdk: { plugins: { list: async () => ({ plugins: [] }) } },
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
      sdk: { plugins: { list: async () => ({ plugins: [] }) } },
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
      const service = h.harness.behavior.runService("startup");
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
      })) as any;
      expect(result.folderId).toBe("folder");
      const spawn = h.harness.inspection.sdk.callsTo("threads.spawn")[0] as any;
      expect(JSON.stringify(spawn)).toContain("/work/repo");
      expect(JSON.stringify(spawn)).toContain("STAGE 1: ANALYSIS ONLY");
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

it("dispatches marketplace feedback in the plugin folder and groups all sources once, excluding bots", async () => {
  let h = await setup();
  try {
    await h.bb.storage.kv.set("item:market", {
      ...first,
      id: "market",
      sourceRepo: "get-bb/marketplace",
      kind: "marketplace",
      url: "https://github.com/get-bb/marketplace/pull/42",
      reason: "checksFailed",
    });
    await h.bb.storage.kv.set("item:bot", {
      ...first,
      id: "bot",
      author: "dependabot[bot]",
      bot: true,
    });
    h = await h.harness.lifecycle.reload(plugin);
    const result: any = await h.harness.behavior.callRpc("batch", null);
    expect(result.threads).toEqual(["thr_safe"]);
    const calls = h.harness.inspection.sdk.callsTo("threads.spawn");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).toContain("/work/repo");
    expect(JSON.stringify(calls)).toContain("marketplace/pull/42");
    expect(JSON.stringify(calls)).not.toContain("dependabot");
    const data: any = await h.harness.behavior.callRpc("list", null);
    expect(data.items.find((i: any) => i.id === "bot").status).toBe("new");
  } finally {
    await h.harness.lifecycle.dispose();
  }
});

it("blocks launch when the installed plugin is disabled", async () => {
  const h = await setup();
  try {
    h.harness.sdk.stub(
      "plugins.list",
      async () =>
        ({
          plugins: [
            {
              id: "repo",
              enabled: false,
              source: "git:https://github.com/owner/repo.git@^0.1.0",
            },
          ],
        }) as any,
    );
    await expect(
      h.harness.behavior.callRpc("run", { id: first.id }),
    ).rejects.toThrow("notWatching");
    const data: any = await h.harness.behavior.callRpc("list", null);
    expect(data.count).toBe(0);
    expect(data.items[0].ignored).toBe(true);
    expect(h.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  } finally {
    await h.harness.lifecycle.dispose();
  }
});

it.each(["implement", "reject"] as const)(
  "continues %s in the same thread only after analysis, with no second spawn",
  async (decision) => {
    const h = await setup();
    let active = false;
    try {
      await h.harness.behavior.callRpc("run", { id: first.id });
      expect((await h.bb.storage.kv.get<any>("item:" + first.id)).status).toBe(
        "analysis",
      );
      await h.harness.behavior.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({ id: "thr_safe", status: "idle" }),
        lastAssistantText: "Русский анализ и English draft",
      });
      h.harness.sdk.stub("threads.get", async () =>
        makeThreadResponse({
          id: "thr_safe",
          status: active ? "active" : "idle",
        }),
      );
      h.harness.sdk.stub("threads.send", async (args: any) => {
        active = true;
        const { makeMessageDispatchHookContext } =
          await import("@get-bb/plugin-sdk/testing");
        await h.harness.registrations.hooks["message.dispatch"]!(
          makeMessageDispatchHookContext({
            thread: makeThreadResponse({ id: "thr_safe" }),
            experimental_submission: {
              pluginId: "repo-pulse",
              data: args.pluginSubmission.data,
            },
          }),
        );
        return {} as any;
      });
      expect(
        ((await h.harness.behavior.callRpc("list", null)) as any).items[0]
          .status,
      ).toBe("awaiting_decision");
      await expect(
        h.harness.behavior.callRpc("run", { id: first.id }),
      ).rejects.toThrow("decisionRequired");
      expect(
        await h.harness.behavior.callRpc("decide", { id: first.id, decision }),
      ).toEqual({ threadId: "thr_safe" });
      expect(h.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
      expect(h.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
      expect(
        JSON.stringify(h.harness.inspection.sdk.callsTo("threads.send")),
      ).toContain("OWNER DECISION — STAGE 2");
      expect(
        ((await h.harness.behavior.callRpc("list", null)) as any).items[0]
          .status,
      ).toBe("implementing");
      active = false;
      const result = decision === "reject" ? "rejected" : "done";
      await h.harness.behavior.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({ id: "thr_safe", status: "idle" }),
        lastAssistantText: `Завершено\nREPO_PULSE_RESULT: ${result}`,
      });
      expect(
        ((await h.harness.behavior.callRpc("list", null)) as any).items[0]
          .status,
      ).toBe(result);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  },
);

it("recognizes a human reply in the same thread, but not another agent's decision", async () => {
  const h = await setup();
  try {
    await h.harness.behavior.callRpc("run", { id: first.id });
    await h.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_safe", status: "idle" }),
      lastAssistantText: "Analysis",
    });
    const { makeMessageDispatchHookContext } =
      await import("@get-bb/plugin-sdk/testing");
    const hook = h.harness.registrations.hooks["message.dispatch"]!;
    await hook(
      makeMessageDispatchHookContext({
        thread: makeThreadResponse({ id: "thr_safe" }),
        initiator: "agent",
        senderThreadId: "thr_other",
        input: { text: "внедряй", blocks: [] },
      }),
    );
    expect((await h.bb.storage.kv.get<any>("item:" + first.id)).status).toBe(
      "awaiting_decision",
    );
    await hook(
      makeMessageDispatchHookContext({
        thread: makeThreadResponse({ id: "thr_safe" }),
        initiator: "user",
        senderThreadId: null,
        input: { text: "вариант 2", blocks: [] },
      }),
    );
    expect(await h.bb.storage.kv.get<any>("item:" + first.id)).toMatchObject({
      status: "implementing",
      decision: "implement",
    });
    expect(h.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  } finally {
    await h.harness.lifecycle.dispose();
  }
});

it("rolls back a failed decision send and does not silently mark an unfinished implementation done", async () => {
  const h = await setup();
  try {
    await h.harness.behavior.callRpc("run", { id: first.id });
    await h.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_safe", status: "idle" }),
      lastAssistantText: "Analysis",
    });
    h.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_safe", status: "idle" }),
    );
    h.harness.sdk.stub("threads.send", async () => {
      throw Error("send failed");
    });
    await expect(
      h.harness.behavior.callRpc("decide", {
        id: first.id,
        decision: "implement",
      }),
    ).rejects.toThrow("send failed");
    expect((await h.bb.storage.kv.get<any>("item:" + first.id)).status).toBe(
      "awaiting_decision",
    );
    h.harness.sdk.stub("threads.send", async () => ({}) as any);
    await h.harness.behavior.callRpc("decide", {
      id: first.id,
      decision: "implement",
    });
    await h.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_safe", status: "idle" }),
      lastAssistantText: "Blocked: validation failed",
    });
    expect((await h.bb.storage.kv.get<any>("item:" + first.id)).status).toBe(
      "awaiting_decision",
    );
  } finally {
    await h.harness.lifecycle.dispose();
  }
});

describe("rate-limit snapshot", () => {
  it("reports core after a final search response, persists the buckets, and keeps them on reload", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const search = new URL(String(input)).pathname.startsWith("/search/");
      return new Response(JSON.stringify(search ? { items: [] } : []), {
        headers: {
          "x-ratelimit-resource": search ? "search" : "core",
          "x-ratelimit-remaining": search ? "29" : "4991",
          "x-ratelimit-limit": search ? "30" : "5000",
          "x-ratelimit-reset": String(
            Math.floor(Date.now() / 1000) + (search ? 60 : 3600),
          ),
        },
      });
    };
    let h = createFakePluginHost({
      pluginId: "repo-pulse",
      settings: { githubToken: "test-only" },
      sdk: { plugins: { list: async () => ({ plugins: [] }) } },
    });
    try {
      await plugin(h.bb);
      const result = await h.harness.behavior.callRpc("refresh", null);
      expect(result).toMatchObject({
        remaining: 4991,
        limits: {
          core: { remaining: 4991, limit: 5000 },
          search: { remaining: 29, limit: 30 },
        },
        errors: [],
      });
      h = await h.harness.lifecycle.reload(plugin);
      expect(await h.harness.behavior.callRpc("list", null)).toMatchObject({
        remaining: 4991,
        limits: { search: { remaining: 29 } },
      });
    } finally {
      globalThis.fetch = original;
      await h.harness.lifecycle.dispose();
    }
  });
});
