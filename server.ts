import {
  DEFAULT_CONTRACT,
  LEGACY_CONTRACT,
  PREVIOUS_CONTRACT,
} from "./agent-contract";
import {
  activePhase,
  analysisPrompt,
  decisionPrompt,
  ownerDecision,
  completion,
} from "./workflow";
import { failedCheck, gateStep, maintainerGateOnly } from "./checks";
import { en } from "./messages";
import { nextCheck, startupDue } from "./schedule";
import { createHash } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  actionable,
  isBot,
  installedRepo,
  marketplaceRepo,
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
  rateLimitsSchema,
} from "./core";
import {
  sectionSchema,
  routeSchema,
  resolveRoute,
  normalizedPath,
  type Section,
} from "./sections";
import { hostContract } from "./host";
const runInput = z.object({
  id: z.string(),
  dryRun: z.boolean().default(false),
  automatic: z.boolean().default(false),
});
const snapshotSchema = z.object({
  items: z.array(itemSchema),
  count: z.number(),
  lastCheck: z.string().nullable(),
  errors: z.array(z.string()),
  authenticated: z.boolean(),
  remaining: z.number().nullable(),
  limits: rateLimitsSchema,
  nextCheck: z.string().nullable(),
  timeZone: z.string(),
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
  track: {
    input: z.object({
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      number: z.number().int().positive(),
    }),
    output: itemSchema,
  },
  decide: {
    input: z.object({
      id: z.string(),
      decision: z.enum(["implement", "reject"]),
      note: z.string().max(10000).default(""),
    }),
    output: z.object({ threadId: z.string() }),
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
  if ([LEGACY_CONTRACT, PREVIOUS_CONTRACT].includes(config.prompt)) {
    config = { ...config, prompt: DEFAULT_CONTRACT };
    await bb.storage.kv.set("config", config);
  }
  const items = new Map<string, Item>();
  for (const key of await bb.storage.kv.list("item:")) {
    const value = itemSchema.safeParse(await bb.storage.kv.get(key));
    if (value.success) {
      const item = { ...value.data };
      if (item.repo === "VKirill/bb-plugin-agency" && !item.closed)
        item.status = "muted";
      if (
        item.kind === "marketplace" &&
        !item.sourceRepo &&
        ["new", "waiting"].includes(item.status)
      )
        item.status = "marketplace_waiting";
      items.set(item.id, item);
      if (JSON.stringify(item) !== JSON.stringify(value.data))
        await bb.storage.kv.set(key, item);
    }
  }
  const storedMeta = await bb.storage.kv.get<{
    lastCheck: string | null;
    errors: string[];
    authenticated: boolean;
    remaining: number | null;
    limits?: unknown;
  }>("meta");
  const savedLimits = rateLimitsSchema.safeParse(storedMeta?.limits ?? {});
  let meta = {
    lastCheck: storedMeta?.lastCheck ?? null,
    errors: storedMeta?.errors ?? [],
    authenticated: storedMeta?.authenticated ?? false,
    // Older snapshots mixed search/core. Do not relabel the old scalar as core.
    remaining: savedLimits.success
      ? (savedLimits.data.core?.remaining ?? null)
      : null,
    limits: savedLimits.success ? savedLimits.data : {},
  };
  let scheduledAt = nextCheck(
    config.schedule,
    config.intervalMinutes,
    Date.now(),
  );
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
  let inactive = new Set<string>();
  let activePlugins = new Set<string>();
  let aliases: { repo: string; names: string[] }[] = [];
  let archivedRepos = new Set(
    (await bb.storage.kv.get<string[]>("archived-repos")) ?? [],
  );
  async function loadInstalled(
    repos = [
      ...new Set([...Object.keys(config.checkouts), ...config.repositories]),
    ],
  ) {
    const { plugins } = await bb.sdk.plugins.list();
    aliases = plugins.flatMap((p) => {
      const repo = installedRepo(p, config.owner, repos);
      return repo
        ? [
            {
              repo,
              names: [
                p.id,
                p.name ?? "",
                repo.split("/")[1].replace(/^bb-plugin-/, ""),
              ],
            },
          ]
        : [];
    });
    activePlugins = new Set(
      plugins
        .filter((p) => p.enabled)
        .map((p) => installedRepo(p, config.owner, repos))
        .filter((r): r is string => !!r)
        .map((r) => r.toLowerCase()),
    );
    inactive = new Set(
      plugins
        .filter((p) => !p.enabled)
        .map((p) => installedRepo(p, config.owner, repos))
        .filter((r): r is string => !!r)
        .map((r) => r.toLowerCase()),
    );
  }
  await loadInstalled();
  const watching = (repo: string) =>
    !inactive.has(repo.toLowerCase()) &&
    !archivedRepos.has(repo.toLowerCase()) &&
    !config.excludedRepositories.some(
      (r) => r.toLowerCase() === repo.toLowerCase(),
    );
  const displayItem = (item: Item): Item => ({
    ...item,
    ignored:
      item.sourceRepo === "get-bb/marketplace"
        ? config.excludedRepositories.some(
            (r) => r.toLowerCase() === item.repo.toLowerCase(),
          )
        : !watching(item.repo) ||
          (item.kind === "ci" && !activePlugins.has(item.repo.toLowerCase())),
  });
  const attention = () =>
    [...items.values()].filter((i) => actionable(displayItem(i))).length;
  const snapshot = () => ({
    ...meta,
    nextCheck: scheduledAt,
    timeZone: config.schedule.timeZone,
    items: [...items.values()]
      .map(displayItem)
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
          .filter((i) => activePhase(i.status) && i.threadId)
          .map((i) => i.threadId!),
      ),
    ];
    for (const id of ids) {
      try {
        const thread = await bb.sdk.threads.get({ threadId: id });
        if (
          !["active", "starting", "pending", "stopping"].includes(thread.status)
        ) {
          let result: "done" | "rejected" | undefined;
          if (
            [...items.values()].some(
              (i) => i.threadId === id && i.status === "implementing",
            )
          ) {
            try {
              result = completion(
                (await bb.sdk.threads.output({ threadId: id })).output,
              );
            } catch {}
          }
          for (const item of items.values())
            if (item.threadId === id && activePhase(item.status))
              await put(threadStatus(item, false, result));
        }
      } catch {
        for (const item of items.values())
          if (item.threadId === id && activePhase(item.status))
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
  async function runUnlocked(id: string, dryRun = false, automatic = false) {
    const item = items.get(id);
    if (!item) throw Error("itemMissing");
    await loadInstalled();
    if (displayItem(item).ignored) throw Error("notWatching");
    if (
      item.reason === "maintainerLabel" ||
      item.status === "maintainer_waiting"
    )
      throw Error("maintainer_waiting");
    if (item.repo === "get-bb/marketplace") throw Error("marketplaceUnmapped");
    if (item.status === "awaiting_decision") throw Error("decisionRequired");
    if (item.closed || ["done", "muted", "rejected"].includes(item.status))
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
        (i) => i.repo === item.repo && activePhase(i.status),
      )
    )
      throw Error("repoBusy");
    if (
      [...items.values()].some(
        (i) => i.repo === item.repo && i.status === "awaiting_decision",
      )
    )
      throw Error("decisionRequired");
    const route = resolveRoute(item.repo, config, await sections());
    if (route.status !== "ready" || !route.folderId) throw Error(route.status);
    const checked = await host.call(
      "inspect",
      { path: route.checkoutPath, repo: item.repo },
      { hostId: route.hostId, signal: lifecycle.signal },
    );
    const checkoutPath = checked.path;
    const group = [...items.values()].filter(
      (i) =>
        i.repo === item.repo &&
        (i.id === id || (i.status === "new" && actionable(displayItem(i)))),
    );
    const prompt = analysisPrompt(config, group, checkoutPath);
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
        phase: "analysis",
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
    for (const entry of group) {
      const next: Item = {
        ...entry,
        status: "analysis",
        threadId: thread.id,
        seen: entry.fingerprint,
      };
      delete next.decision;
      await put(next);
    }
    publish();
    return {
      threadId: thread.id,
      prompt: "",
      checkoutPath,
      projectId: route.projectId,
      folderId: route.folderId,
    };
  }
  async function decideUnlocked(
    id: string,
    decision: "implement" | "reject",
    note: string,
  ) {
    await reconcile();
    const item = items.get(id);
    await loadInstalled();
    if (item && displayItem(item).ignored) throw Error("notWatching");
    if (!item?.threadId) throw Error("itemMissing");
    if (item.status !== "awaiting_decision" || item.closed)
      throw Error("decisionRequired");
    const thread = await bb.sdk.threads.get({ threadId: item.threadId });
    if (["active", "starting", "pending", "stopping"].includes(thread.status))
      throw Error("repoBusy");
    const route = resolveRoute(item.repo, config, await sections());
    if (route.status !== "ready") throw Error(route.status);
    await host.call(
      "inspect",
      { path: route.checkoutPath, repo: item.repo },
      { hostId: route.hostId, signal: lifecycle.signal },
    );
    // Persist before send; our dispatch hook recognizes pluginSubmission and never re-enters this queue.
    await put({ ...item, status: "implementing", decision });
    try {
      await bb.sdk.threads.send({
        threadId: item.threadId,
        input: [
          {
            type: "text",
            mentions: [],
            text: decisionPrompt(
              config,
              [item],
              route.checkoutPath,
              decision,
              note,
            ),
          },
        ],
        mode: "start",
        permissionMode: config.permission,
        pluginSubmission: { pluginId: "repo-pulse", data: { id, decision } },
      });
    } catch (e) {
      await put(item);
      throw e;
    }
    publish();
    return { threadId: item.threadId };
  }
  async function batchUnlocked(automatic = false) {
    await loadInstalled();
    const threads: string[] = [],
      errors: string[] = [];
    const repos = new Set<string>();
    for (const item of [...items.values()]) {
      if (
        !actionable(displayItem(item)) ||
        item.status !== "new" ||
        repos.has(item.repo)
      )
        continue;
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
    const credential = await token();
    const rateKey =
      "rate-limits:" +
      createHash("sha256")
        .update(credential ?? "anonymous")
        .digest("hex");
    const stored = rateLimitsSchema.safeParse(
      (await bb.storage.kv.get(rateKey)) ?? {},
    );
    const api = new Github(
      credential,
      {
        get: async (key) =>
          bb.storage.kv.get<CacheEntry>(
            "http:v3:" + createHash("sha256").update(key).digest("hex"),
          ),
        set: async (key, value) => {
          await bb.storage.kv.set(
            "http:v3:" + createHash("sha256").update(key).digest("hex"),
            value,
          );
        },
      },
      fetch,
      budget,
      pollSignal,
      stored.success ? stored.data : {},
    );
    const errors: string[] = [];
    let newCount = 0;
    async function accept(incoming: Item) {
      const old = items.get(incoming.id);
      const next = mergeItem(old, incoming);
      if (
        actionable(displayItem(next)) &&
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
      for (const row of rows) {
        try {
          let target = repo;
          let pull: any;
          if (marketplace) {
            pull = await api.get(`/repos/${repo}/pulls/${row.number}`);
            const files = await api.pages(
              `/repos/${repo}/pulls/${row.number}/files`,
            );
            const entries: unknown[] = [];
            for (const file of files.filter((f) =>
              /^entries\/[^/]+\.json$/.test(f.filename),
            )) {
              const entry = await api.get(
                `/repos/${pull.head.repo.full_name}/contents/${file.filename}?ref=${encodeURIComponent(pull.head.sha)}`,
              );
              if (entry.encoding !== "base64")
                throw Error("marketplaceUnmapped");
              entries.push(
                JSON.parse(
                  Buffer.from(entry.content, "base64").toString("utf8"),
                ),
              );
            }
            target = marketplaceRepo(entries, config.owner, {
              files: files.map((f) => f.filename),
              title: row.title,
              aliases,
            });
          }
          const decorate = (item: Item): Item => ({
            ...item,
            repo: target,
            ...(marketplace ? { sourceRepo: repo } : {}),
          });
          const parent = decorate(
            githubItem(
              repo,
              marketplace ? "marketplace" : row.pull_request ? "pr" : "issue",
              row,
            ),
          );
          if (marketplace) {
            const checks: any[] = [];
            for (let page = 1; page <= 10; page++) {
              const result = await api.get(
                `/repos/${repo}/commits/${pull.head.sha}/check-runs?per_page=100&page=${page}`,
              );
              checks.push(...(result.check_runs ?? []));
              if ((result.check_runs?.length ?? 0) < 100) break;
              if (page === 10) throw Error("paginationLimit");
            }
            const statuses = await api.get(
              `/repos/${repo}/commits/${pull.head.sha}/status`,
            );
            const failed = checks.filter((c) => failedCheck(c.conclusion));
            let gateOnlyCount = 0;
            for (const check of failed) {
              if (
                check.conclusion !== "failure" ||
                !Number.isSafeInteger(check.id) ||
                !check.completed_at
              )
                continue;
              const key = `gate-result:v1:${check.id}:${check.completed_at}`;
              const cached = await bb.storage.kv.get<{ gateOnly: boolean }>(
                key,
              );
              let gateOnly = cached?.gateOnly;
              if (gateOnly === undefined) {
                try {
                  const annotations = await api.pages(
                    `/repos/${repo}/check-runs/${check.id}/annotations`,
                  );
                  const detailPath = new URL(
                    check.details_url ?? "https://github.com/",
                  );
                  const jobId =
                    detailPath.hostname === "github.com" &&
                    detailPath.pathname.startsWith(`/${repo}/actions/runs/`)
                      ? detailPath.pathname.match(/\/job\/(\d+)(?:\/|$)/)?.[1]
                      : undefined;
                  const job = jobId
                    ? await api.get(`/repos/${repo}/actions/jobs/${jobId}`)
                    : undefined;
                  const failures = job?.steps?.filter((step: any) =>
                    failedCheck(step.conclusion),
                  );
                  let log = "";
                  if (
                    jobId &&
                    failures?.length &&
                    failures.every((step: any) => gateStep(step.name)) &&
                    !maintainerGateOnly(check, annotations, job.steps)
                  )
                    log = await api.jobLog(repo, jobId);
                  gateOnly = maintainerGateOnly(
                    check,
                    annotations,
                    job?.steps,
                    log,
                  );
                  await bb.storage.kv.set(key, { gateOnly });
                } catch {
                  // Unknown evidence is a real failure until a later poll can verify the gate.
                  errors.push(
                    `${repo} #${row.number}: gateEvidenceUnavailable`,
                  );
                  gateOnly = false;
                }
              }
              if (gateOnly) gateOnlyCount++;
            }
            const otherFailure =
              failed.length > gateOnlyCount ||
              ["failure", "error"].includes(statuses.state);
            const waitingLabel = !otherFailure && gateOnlyCount > 0;
            parent.status = otherFailure
              ? "new"
              : waitingLabel
                ? "maintainer_waiting"
                : "marketplace_waiting";
            if (otherFailure) parent.reason = "checksFailed";
            else if (waitingLabel) parent.reason = "maintainerLabel";
            parent.bot = false;
            parent.fingerprint = JSON.stringify([
              parent.fingerprint,
              pull.head.sha,
              otherFailure,
              waitingLabel,
            ]);
          }
          if (
            row.user?.login?.toLowerCase() !== config.owner.toLowerCase() ||
            marketplace ||
            items.get(parent.id)?.manual
          )
            await accept(parent);
          const feedback = async (kind: "comment" | "review", rows: any[]) => {
            for (const entry of rows)
              if (
                entry.user?.login?.toLowerCase() !==
                  config.owner.toLowerCase() &&
                !(
                  kind === "review" &&
                  ["PENDING", "DISMISSED"].includes(entry.state)
                )
              )
                await accept(
                  decorate({
                    ...githubItem(repo, kind, entry, row.number),
                    title: row.title,
                    closed: row.state === "closed",
                  }),
                );
          };
          await feedback(
            "comment",
            await api.pages(`/repos/${repo}/issues/${row.number}/comments`),
          );
          if (row.pull_request || marketplace) {
            await feedback(
              "review",
              await api.pages(`/repos/${repo}/pulls/${row.number}/reviews`),
            );
            await feedback(
              "comment",
              await api.pages(`/repos/${repo}/pulls/${row.number}/comments`),
            );
          }
        } catch (e) {
          errors.push(
            `${repo} #${row.number}: ${e instanceof Error ? e.message : "pollFailed"}`,
          );
        }
      }
      // Only explicit closed responses resolve an item; absence from a partial list never does.
      const tracked = [...items.values()].filter(
        (i) =>
          (i.sourceRepo ?? i.repo) === repo &&
          !i.closed &&
          i.kind !== "ci" &&
          !rows.some((r: any) => r.number === i.number),
      );
      for (const number of new Set(tracked.map((i) => i.number))) {
        const row = await api.get(`/repos/${repo}/issues/${number}`);
        if (row.state === "closed")
          for (const item of tracked.filter((i) => i.number === number))
            await put({
              ...item,
              closed: true,
              status: item.decision === "reject" ? "rejected" : "done",
            });
      }
      if (!marketplace && activePlugins.has(repo.toLowerCase())) {
        const details = await api.get(`/repos/${repo}`);
        if (details.archived) {
          archivedRepos.add(repo.toLowerCase());
          return;
        }
        const runs = await api.get(
          `/repos/${repo}/actions/runs?branch=${encodeURIComponent(details.default_branch)}&per_page=1`,
        );
        const latest = runs.workflow_runs?.[0];
        if (latest?.conclusion === "failure")
          await accept({ ...githubItem(repo, "ci", latest), bot: false });
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
        archivedRepos = new Set(
          discovered
            .filter((r) => r.archived)
            .map((r) => r.full_name.toLowerCase()),
        );
        repos = discovered
          .filter(
            (r) =>
              r.name.startsWith("bb-plugin-") ||
              r.name === "claude-lane-stack" ||
              Object.keys(config.checkouts).some(
                (repo) => repo.toLowerCase() === r.full_name.toLowerCase(),
              ),
          )
          .map((r) => r.full_name);
      }
      await loadInstalled(repos);
      if (config.repositories.length) {
        for (const repo of repos) {
          try {
            const details = await api.get(`/repos/${repo}`);
            if (details.archived) archivedRepos.add(repo.toLowerCase());
            else archivedRepos.delete(repo.toLowerCase());
          } catch (e) {
            errors.push(
              `${repo}: ${e instanceof Error ? e.message : "pollFailed"}`,
            );
          }
        }
      }
      for (const repo of repos.filter(watching)) {
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
    await bb.storage.kv.set("archived-repos", [...archivedRepos]);
    await bb.storage.kv.set("anonymous-budget", budget);
    await bb.storage.kv.set(rateKey, api.limits);
    pollSignal.throwIfAborted();
    meta = {
      lastCheck: new Date().toISOString(),
      errors: errors.slice(0, 100),
      authenticated: api.authenticated,
      remaining: api.remaining,
      limits: api.limits,
    };
    scheduledAt = nextCheck(
      config.schedule,
      config.intervalMinutes,
      Date.now(),
    );
    await bb.storage.kv.set("meta", meta);
    if (newCount) bb.realtime.publish("new-items", { count: newCount });
    publish();
    if (config.automatic) await batchUnlocked(true);
    return snapshot();
  }
  async function track(repo: string, number: number) {
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
      !Number.isSafeInteger(number) ||
      number <= 0
    )
      throw Error("invalidSettings");
    if (repo.split("/")[0].toLowerCase() !== config.owner.toLowerCase())
      throw Error("itemMissing");
    const budget = (await bb.storage.kv.get<{ used: number; reset: number }>(
      "anonymous-budget",
    )) ?? { used: 0, reset: Date.now() + 3600000 };
    const credential = await token();
    const rateKey =
      "rate-limits:" +
      createHash("sha256")
        .update(credential ?? "anonymous")
        .digest("hex");
    const stored = rateLimitsSchema.safeParse(
      (await bb.storage.kv.get(rateKey)) ?? {},
    );
    const api = new Github(
      credential,
      { get: async () => undefined, set: async () => {} },
      fetch,
      budget,
      lifecycle.signal,
      stored.success ? stored.data : {},
    );
    try {
      const row = await api.get(`/repos/${repo}/issues/${number}`);
      const item: Item = {
        ...githubItem(repo, row.pull_request ? "pr" : "issue", row),
        manual: true,
      };
      await put(mergeItem(items.get(item.id), item));
      publish();
      return items.get(item.id)!;
    } finally {
      await bb.storage.kv.set(rateKey, api.limits);
      await bb.storage.kv.set("anonymous-budget", budget);
    }
  }
  bb.rpc.register(rpcContract, {
    list: () =>
      serial(async () => {
        await loadInstalled();
        await reconcile();
        return snapshot();
      }),
    refresh: () => serial(() => refresh()),
    config: async () => config,
    save_config: (next) =>
      serial(async () => {
        config = next;
        scheduledAt = nextCheck(
          config.schedule,
          config.intervalMinutes,
          Date.now(),
        );
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
      serial(() => runUnlocked(input.id, input.dryRun, input.automatic)),
    batch: () => serial(() => batchUnlocked()),
    track: ({ repo, number }) => serial(() => track(repo, number)),
    decide: ({ id, decision, note }) =>
      serial(() => decideUnlocked(id, decision, note)),
    mark: ({ id, status }) =>
      serial(async () => {
        const item = items.get(id);
        if (!item) throw Error("itemMissing");
        if (activePhase(item.status)) throw Error("repoBusy");
        await put({
          ...item,
          status:
            status === "new" && item.reason === "maintainerLabel"
              ? "maintainer_waiting"
              : status,
          seen: item.fingerprint,
        });
        publish();
        return true;
      }),
  });
  bb.experimental_hooks.on("message.dispatch", async (context) => {
    if (context.experimental_submission?.pluginId === "repo-pulse")
      return { action: "proceed" };
    if (context.initiator !== "user" || context.senderThreadId !== null)
      return { action: "proceed" };
    const decision = ownerDecision(context.input.text);
    if (!decision) return { action: "proceed" };
    await serial(async () => {
      for (const item of items.values())
        if (
          item.threadId === context.thread.id &&
          item.status === "awaiting_decision" &&
          !item.closed
        )
          await put({ ...item, status: "implementing", decision });
      publish();
    });
    return { action: "proceed" };
  });
  for (const event of [
    "thread.active",
    "thread.idle",
    "thread.failed",
    "thread.archived",
    "thread.deleted",
    "interaction.pending",
  ] as const)
    bb.events.on(event, (payload) =>
      serial(async () => {
        if (event === "interaction.pending") {
          publish();
          return;
        }
        const result = completion(
          "lastAssistantText" in payload
            ? payload.lastAssistantText
            : undefined,
        );
        for (const item of items.values())
          if (item.threadId === payload.thread.id)
            await put(threadStatus(item, event === "thread.active", result));
        publish();
      }),
    );
  // SDK cron is server-local and has no timezone option. Its durable minute tick
  // only checks our zoned due instant; GitHub is contacted solely when due.
  bb.background.schedule("poll", "* * * * *", () =>
    serial(async () => {
      if (
        config.projectId &&
        scheduledAt &&
        Date.now() >= Date.parse(scheduledAt)
      )
        await refresh();
    }),
  );
  bb.background.service("startup", {
    async start(signal) {
      try {
        await serial(async () => {
          if (
            !signal.aborted &&
            config.projectId &&
            config.schedule.mode !== "off" &&
            startupDue(meta.lastCheck, Date.now())
          )
            await refresh(signal);
        });
      } catch (error) {
        if (!signal.aborted) throw error;
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
        name: "track",
        summary: "Explicitly track an owned issue or PR",
        usage: "bb repo-pulse track <owner/repo> <number>",
      },
      {
        name: "decide",
        summary: "Continue a linked analysis in the same thread",
        usage: "bb repo-pulse decide <item-id> <implement|reject> [owner note]",
      },
      {
        name: "run",
        summary: "Launch analysis per repository",
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
          case "track":
            result = await serial(() => track(argv[1] ?? "", Number(argv[2])));
            break;
          case "decide": {
            const choice = z.enum(["implement", "reject"]).parse(argv[2]);
            result = await serial(() =>
              decideUnlocked(argv[1] ?? "", choice, argv.slice(3).join(" ")),
            );
            break;
          }
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
              .filter((i) => actionable(displayItem(i)))
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
