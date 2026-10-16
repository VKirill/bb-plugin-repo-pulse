import { en } from "./messages";
import { createHash } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  configSchema,
  itemSchema,
  mergeItem,
  threadStatus,
  buildPrompt,
  Github,
  githubItem,
  type Config,
  type Item,
  type CacheEntry,
} from "./core";
import {
  sectionSchema,
  routeSchema,
  resolveRoute,
  normalizedPath,
  reportPrompt,
  type Section,
} from "./sections";
import { hostContract } from "./host";
const runInput = z.object({
  id: z.string(),
  dryRun: z.boolean().default(false),
  automatic: z.boolean().default(false),
  reportOnly: z.boolean().default(false),
});
const snapshotSchema = z.object({
  items: z.array(itemSchema),
  count: z.number(),
  lastCheck: z.string().nullable(),
  errors: z.array(z.string()),
  authenticated: z.boolean(),
  remaining: z.number().nullable(),
});
export const rpcContract = defineRpcContract({
  list: { input: z.null(), output: snapshotSchema },
  refresh: { input: z.null(), output: snapshotSchema },
  config: { input: z.null(), output: configSchema },
  save_config: { input: configSchema, output: configSchema },
  scan: { input: z.null(), output: z.record(z.string(), z.string()) },
  routes: {
    input: z.null(),
    output: z.object({
      sections: z.array(sectionSchema),
      routes: z.array(routeSchema),
    }),
  },
  bind_section: {
    input: z.object({ repo: z.string(), folderId: z.string().nullable() }),
    output: routeSchema,
  },
  create_section: {
    input: z.object({ repo: z.string() }),
    output: routeSchema,
  },
  run: {
    input: runInput,
    output: z.object({
      threadId: z.string().nullable(),
      prompt: z.string(),
      checkoutPath: z.string(),
      projectId: z.string(),
      folderId: z.string(),
    }),
  },
  batch: {
    input: z.null(),
    output: z.object({
      threads: z.array(z.string()),
      errors: z.array(z.string()),
    }),
  },
  mark: {
    input: z.object({
      id: z.string(),
      status: z.enum(["new", "done", "muted", "waiting"]),
    }),
    output: z.boolean(),
  },
});
export default async function plugin(bb: BbPluginApi) {
  const secrets = bb.settings.define({
    githubToken: {
      type: "string",
      label: en.token,
      secret: true,
    },
  });
  let config = configSchema.parse((await bb.storage.kv.get("config")) ?? {});
  const items = new Map<string, Item>();
  for (const key of await bb.storage.kv.list("item:")) {
    const value = itemSchema.safeParse(await bb.storage.kv.get(key));
    if (value.success) items.set(value.data.id, value.data);
  }
  let meta = (await bb.storage.kv.get<{
    lastCheck: string | null;
    errors: string[];
    authenticated: boolean;
    remaining: number | null;
  }>("meta")) ?? {
    lastCheck: null,
    errors: [],
    authenticated: false,
    remaining: null,
  };
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const lifecycle = new AbortController();
  bb.onDispose(async () => {
    lifecycle.abort();
    await queue;
  });
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(() => fn());
    queue = next.catch(() => {});
    return next;
  }
  const attention = () =>
    [...items.values()].filter(
      (i) => i.status === "new" || i.status === "waiting",
    ).length;
  const snapshot = () => ({
    ...meta,
    items: [...items.values()]
      .sort((a, b) => b.updated.localeCompare(a.updated))
      .slice(0, 2000),
    count: attention(),
  });
  const publish = () => bb.realtime.publish("changed", { count: attention() });
  async function put(item: Item) {
    items.set(item.id, item);
    await bb.storage.kv.set("item:" + item.id, item);
  }
  async function token() {
    const own = (await secrets.get()).githubToken;
    if (own) return own;
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: "env-catalog",
        method: "env_get_value",
        input: { name: "GH_TOKEN" },
        outputSchema: z.object({ value: z.string().nullable().optional() }),
      });
      return result.value ?? undefined;
    } catch {
      return undefined;
    }
  }
  async function reconcile() {
    const ids = [
      ...new Set(
        [...items.values()]
          .filter((i) => i.status === "running" && i.threadId)
          .map((i) => i.threadId!),
      ),
    ];
    for (const id of ids) {
      try {
        const thread = await bb.sdk.threads.get({ threadId: id });
        if (
          !["active", "starting", "pending", "stopping"].includes(thread.status)
        )
          for (const item of items.values())
            if (item.threadId === id && item.status === "running")
              await put(threadStatus(item, false));
      } catch {
        for (const item of items.values())
          if (item.threadId === id && item.status === "running")
            await put(threadStatus(item, false));
      }
    }
  }
  async function scan() {
    if (!config.hostId || !config.scanRoot) throw Error("configureHost");
    const found = await host.call(
      "scan",
      { root: config.scanRoot },
      { hostId: config.hostId, signal: lifecycle.signal },
    );
    config = { ...config, checkouts: { ...found, ...config.checkouts } };
    await bb.storage.kv.set("config", config);
    return config.checkouts;
  }
  async function sections(): Promise<Section[]> {
    try {
      return (
        await bb.sdk.plugins.callRpc({
          pluginId: "project-folders",
          method: "sections_list",
          input: {},
          outputSchema: z.object({ sections: z.array(sectionSchema) }),
        })
      ).sections;
    } catch {
      throw Error("foldersUnavailable");
    }
  }
  async function routes() {
    const rows = await sections();
    const repos = [
      ...new Set([
        ...Object.keys(config.checkouts),
        ...Object.keys(config.bindings),
        ...[...items.values()].map((i) => i.repo),
        ...config.repositories,
      ]),
    ];
    return {
      sections: rows,
      routes: repos.map((repo) => resolveRoute(repo, config, rows)),
    };
  }
  async function bindSection(repo: string, folderId: string | null) {
    const rows = await sections();
    const bindings = { ...config.bindings };
    if (folderId) {
      const section = rows.find(
        (s) => s.id === folderId && s.kind === "folder",
      );
      if (!section) throw Error("sectionMissing");
      const current = resolveRoute(repo, config, rows);
      if (section.hostId !== current.hostId) throw Error("bindingInvalid");
      if (!current.checkoutPath) throw Error("configureCheckout");
      bindings[repo] = {
        projectId: section.projectId,
        folderId: section.id,
        hostId: section.hostId,
        checkoutPath: current.checkoutPath,
      };
    } else delete bindings[repo];
    config = { ...config, bindings };
    await bb.storage.kv.set("config", config);
    publish();
    return resolveRoute(repo, config, rows);
  }
  async function createSection(repo: string) {
    const rows = await sections();
    const route = resolveRoute(repo, config, rows);
    if (route.status === "ready") return route;
    if (!route.checkoutPath || !route.hostId || !route.projectId)
      throw Error("configureCheckout");
    const checked = await host.call(
      "inspect",
      { path: route.checkoutPath, repo },
      { hostId: route.hostId, signal: lifecycle.signal },
    );
    const parent =
      rows.find(
        (s) =>
          s.id === config.parentFolderId &&
          s.hostId === route.hostId &&
          s.projectId === route.projectId,
      ) ??
      rows.find(
        (s) =>
          s.projectId === route.projectId &&
          s.hostId === route.hostId &&
          normalizedPath(s.path) === normalizedPath(config.scanRoot),
      );
    if (!parent) throw Error("parentMissing");
    const created = await bb.sdk.plugins.callRpc({
      pluginId: "project-folders",
      method: "create",
      input: {
        projectId: route.projectId,
        folderId: parent.id,
        hostId: route.hostId,
        name: repo
          .split("/")
          .pop()!
          .replace(/^bb-plugin-/, "")
          .replace(/^bb-/, ""),
        relativePath: checked.path,
      },
      outputSchema: z.object({ id: z.string() }),
    });
    return bindSection(repo, created.id);
  }
  async function runUnlocked(
    id: string,
    dryRun = false,
    automatic = false,
    reportOnly = false,
  ) {
    const item = items.get(id);
    if (!item) throw Error("itemMissing");
    if (item.closed || item.status === "done" || item.status === "muted")
      throw Error("itemResolved");
    await reconcile();
    for (const threadId of new Set(
      [...items.values()]
        .filter((i) => i.repo === item.repo && i.threadId)
        .map((i) => i.threadId!),
    )) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (["active", "starting", "pending", "stopping"].includes(thread.status))
        throw Error("repoBusy");
    }
    if (
      [...items.values()].some(
        (i) => i.repo === item.repo && i.status === "running",
      )
    )
      throw Error("repoBusy");
    const route = resolveRoute(item.repo, config, await sections());
    if (route.status !== "ready" || !route.folderId) throw Error(route.status);
    const checked = await host.call(
      "inspect",
      { path: route.checkoutPath, repo: item.repo },
      { hostId: route.hostId, signal: lifecycle.signal },
    );
    const checkoutPath = checked.path;
    const group = [...items.values()].filter(
      (i) => i.repo === item.repo && (i.id === id || i.status === "new"),
    );
    const prompt = reportOnly
      ? reportPrompt(item.repo, item.url, checkoutPath)
      : buildPrompt(config, group, checkoutPath, automatic);
    if (dryRun)
      return {
        threadId: null,
        prompt,
        checkoutPath,
        projectId: route.projectId,
        folderId: route.folderId,
      };
    const thread = await bb.sdk.threads.spawn({
      projectId: route.projectId,
      environment: {
        type: "host",
        hostId: route.hostId,
        workspace: { type: "unmanaged", path: checkoutPath },
      },
      providerId: config.provider,
      model: config.model,
      reasoningLevel: config.reasoning,
      permissionMode: config.permission,
      prompt,
      title: `Repo Pulse: ${item.repo}`,
      pluginMetadata: {
        repo: item.repo,
        itemIds: group.map((i) => i.id),
        automatic,
        reportOnly,
        folderId: route.folderId,
        checkoutPath,
      },
    });
    try {
      await bb.sdk.plugins.callRpc({
        pluginId: "project-folders",
        method: "thread_place",
        input: {
          threadId: thread.id,
          projectId: route.projectId,
          folderId: route.folderId,
        },
        outputSchema: z.object({ ok: z.literal(true) }),
      });
    } catch {
      await bb.sdk.threads.stop({ threadId: thread.id });
      throw Error("placementFailed");
    }
    for (const entry of group)
      await put({
        ...entry,
        status: "running",
        threadId: thread.id,
        seen: entry.fingerprint,
      });
    publish();
    return {
      threadId: thread.id,
      prompt: "",
      checkoutPath,
      projectId: route.projectId,
      folderId: route.folderId,
    };
  }
  async function batchUnlocked(automatic = false) {
    const threads: string[] = [],
      errors: string[] = [];
    const repos = new Set<string>();
    for (const item of [...items.values()]) {
      if (item.status !== "new" || repos.has(item.repo)) continue;
      repos.add(item.repo);
      try {
        const result = await runUnlocked(item.id, false, automatic);
        if (result.threadId) threads.push(result.threadId);
      } catch (e) {
        errors.push(
          `${item.repo}: ${e instanceof Error ? e.message : "launchFailed"}`,
        );
      }
    }
    return { threads, errors };
  }
  async function refresh(serviceSignal?: AbortSignal) {
    const pollSignal = AbortSignal.any([
      lifecycle.signal,
      ...(serviceSignal ? [serviceSignal] : []),
    ]);
    pollSignal.throwIfAborted();
    await reconcile();
    if (
      config.hostId &&
      config.scanRoot &&
      !Object.keys(config.checkouts).length
    )
      await scan();
    const budget = (await bb.storage.kv.get<{ used: number; reset: number }>(
      "anonymous-budget",
    )) ?? { used: 0, reset: Date.now() + 3600000 };
    const api = new Github(
      await token(),
      {
        get: async (key) =>
          bb.storage.kv.get<CacheEntry>(
            "http:" + createHash("sha256").update(key).digest("hex"),
          ),
        set: async (key, value) => {
          await bb.storage.kv.set(
            "http:" + createHash("sha256").update(key).digest("hex"),
            value,
          );
        },
      },
      fetch,
      budget,
      pollSignal,
    );
    const errors: string[] = [];
    let newCount = 0;
    async function accept(incoming: Item) {
      const old = items.get(incoming.id);
      const next = mergeItem(old, incoming);
      if (
        next.status === "new" &&
        (!old || old.fingerprint !== incoming.fingerprint)
      )
        newCount++;
      await put(next);
    }
    async function collect(repo: string, marketplace = false) {
      const rows = marketplace
        ? (
            await api.get(
              `/search/issues?q=${encodeURIComponent(`repo:get-bb/marketplace is:pr is:open author:${config.owner}`)}&per_page=100`,
            )
          ).items
        : await api.pages(`/repos/${repo}/issues?state=open`);
      const current = new Set<string>();
      for (const row of rows) {
        const kind = marketplace
          ? "marketplace"
          : row.pull_request
            ? "pr"
            : "issue";
        const parent = githubItem(repo, kind, row);
        current.add(parent.id);
        if (
          row.user?.login?.toLowerCase() !== config.owner.toLowerCase() ||
          marketplace
        )
          await accept(parent);
        const comments = await api.pages(
          `/repos/${repo}/issues/${row.number}/comments`,
        );
        for (const comment of comments)
          if (comment.user?.login?.toLowerCase() !== config.owner.toLowerCase())
            await accept({
              ...githubItem(repo, "comment", comment, row.number),
              title: `${row.title} · #${row.number}`,
              closed: row.state === "closed",
            });
        if (row.pull_request || marketplace) {
          const reviews = await api.pages(
            `/repos/${repo}/pulls/${row.number}/reviews`,
          );
          for (const review of reviews)
            if (
              review.user?.login?.toLowerCase() !== config.owner.toLowerCase()
            )
              await accept({
                ...githubItem(repo, "review", review, row.number),
                title: `${row.title} · ${review.state}`,
                closed: row.state === "closed",
              });
          const inline = await api.pages(
            `/repos/${repo}/pulls/${row.number}/comments`,
          );
          for (const comment of inline)
            if (
              comment.user?.login?.toLowerCase() !== config.owner.toLowerCase()
            )
              await accept({
                ...githubItem(repo, "comment", comment, row.number),
                title: `${row.title} · #${row.number}`,
                closed: row.state === "closed",
              });
        }
      }
      // Only explicit closed responses resolve an item; absence from a partial list never does.
      const tracked = [...items.values()].filter(
        (i) =>
          i.repo === repo &&
          !i.closed &&
          i.kind !== "ci" &&
          !rows.some((r: any) => r.number === i.number),
      );
      for (const number of new Set(tracked.map((i) => i.number))) {
        const row = await api.get(`/repos/${repo}/issues/${number}`);
        if (row.state === "closed")
          for (const item of tracked.filter((i) => i.number === number))
            await put({ ...item, closed: true, status: "done" });
      }
      if (!marketplace) {
        const details = await api.get(`/repos/${repo}`);
        const runs = await api.get(
          `/repos/${repo}/actions/runs?branch=${encodeURIComponent(details.default_branch)}&per_page=1`,
        );
        const latest = runs.workflow_runs?.[0];
        if (latest?.conclusion === "failure")
          await accept(githubItem(repo, "ci", latest));
        if (latest?.conclusion === "success")
          for (const item of items.values())
            if (item.repo === repo && item.kind === "ci" && !item.closed)
              await put({ ...item, status: "done", closed: true });
      }
    }
    try {
      let repos = config.repositories;
      if (!repos.length) {
        const discovered = await api.pages(
          `/users/${config.owner}/repos?type=owner&sort=full_name`,
        );
        repos = discovered
          .filter(
            (r) =>
              r.name.startsWith("bb-plugin-") || r.name === "claude-lane-stack",
          )
          .map((r) => r.full_name);
      }
      for (const repo of repos) {
        if (pollSignal.aborted) break;
        try {
          await collect(repo);
        } catch (e) {
          errors.push(
            `${repo}: ${e instanceof Error ? e.message : "pollFailed"}`,
          );
        }
      }
      if (config.marketplace)
        try {
          await collect("get-bb/marketplace", true);
        } catch (e) {
          errors.push(
            `marketplace: ${e instanceof Error ? e.message : "pollFailed"}`,
          );
        }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "pollFailed");
    }
    await bb.storage.kv.set("anonymous-budget", budget);
    pollSignal.throwIfAborted();
    meta = {
      lastCheck: new Date().toISOString(),
      errors: errors.slice(0, 100),
      authenticated: api.authenticated,
      remaining: api.remaining,
    };
    await bb.storage.kv.set("meta", meta);
    if (newCount) bb.realtime.publish("new-items", { count: newCount });
    publish();
    if (config.automatic) await batchUnlocked(true);
    return snapshot();
  }
  bb.rpc.register(rpcContract, {
    list: () =>
      serial(async () => {
        await reconcile();
        return snapshot();
      }),
    refresh: () => serial(() => refresh()),
    config: async () => config,
    save_config: (next) =>
      serial(async () => {
        config = next;
        await bb.storage.kv.set("config", config);
        publish();
        return config;
      }),
    scan: () => serial(scan),
    routes: () => serial(routes),
    bind_section: ({ repo, folderId }) =>
      serial(() => bindSection(repo, folderId)),
    create_section: ({ repo }) => serial(() => createSection(repo)),
    run: (input) =>
      serial(() =>
        runUnlocked(input.id, input.dryRun, input.automatic, input.reportOnly),
      ),
    batch: () => serial(() => batchUnlocked()),
    mark: ({ id, status }) =>
      serial(async () => {
        const item = items.get(id);
        if (!item) throw Error("itemMissing");
        if (item.status === "running") throw Error("repoBusy");
        await put({ ...item, status, seen: item.fingerprint });
        publish();
        return true;
      }),
  });
  for (const event of [
    "thread.active",
    "thread.idle",
    "thread.failed",
    "thread.archived",
    "thread.deleted",
    "interaction.pending",
  ] as const)
    bb.events.on(event, ({ thread }) =>
      serial(async () => {
        for (const item of items.values())
          if (item.threadId === thread.id)
            await put(threadStatus(item, event === "thread.active"));
        publish();
      }),
    );
  bb.background.service("poll", {
    async start(signal) {
      while (!signal.aborted) {
        if (
          config.projectId &&
          Date.now() - Date.parse(meta.lastCheck ?? "1970-01-01") >=
            config.intervalMinutes * 60000
        )
          try {
            await serial(() => refresh(signal));
          } catch (error) {
            if (signal.aborted) return;
            throw error;
          }
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, 60000);
          signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      }
    },
  });
  bb.cli.register({
    name: "repo-pulse",
    summary: "Monitor owned plugin repositories and launch linked agents",
    commands: [
      {
        name: "list",
        summary: "List attention items",
        usage: "bb repo-pulse list [--json]",
      },
      {
        name: "refresh",
        summary: "Poll GitHub now",
        usage: "bb repo-pulse refresh",
      },
      {
        name: "run",
        summary: "Launch one agent per repository",
        usage: "bb repo-pulse run <item-id> [--dry-run]",
      },
    ],
    run: async (argv) => {
      try {
        let result: unknown;
        switch (argv[0]) {
          case "list":
            result = snapshot();
            break;
          case "refresh":
            result = await serial(() => refresh());
            break;
          case "run":
            result = await serial(() =>
              runUnlocked(argv[1] ?? "", argv.includes("--dry-run")),
            );
            break;
          default:
            return {
              exitCode: 0,
              stdout:
                "bb repo-pulse list [--json] | refresh | run <item-id> [--dry-run]",
            };
        }
        return { exitCode: 0, stdout: JSON.stringify(result) };
      } catch (e) {
        return {
          exitCode: 1,
          stderr: e instanceof Error ? e.message : "failed",
        };
      }
    },
  });
  bb.agents.registerTool({
    name: "repo_pulse_list",
    description:
      "List up to 50 Repo Pulse items requiring attention. Read-only. No model calls.",
    parameters: z.object({
      limit: z.number().int().min(1).max(50).default(20),
    }),
    execute: async ({ limit }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            count: attention(),
            items: [...items.values()]
              .filter((i) => i.status === "new" || i.status === "waiting")
              .slice(0, limit)
              .map(({ id, repo, kind, title, url, status, threadId }) => ({
                id,
                repo,
                kind,
                title,
                url,
                status,
                threadId,
              })),
          }),
        },
      ],
    }),
  });
}
