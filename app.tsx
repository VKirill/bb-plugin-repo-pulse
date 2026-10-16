import { useState, useEffect, useCallback } from "react";
import {
  definePluginApp,
  useRpc,
  useRealtime,
  useBbNavigate,
  useBbContext,
  UrlLink,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { actionable, isBot, type Config, type Item } from "./core";
import { useRoutes, RepositorySection } from "./repository-sections";
import { mountChromeLocalization, detectLocale } from "./i18n";
import { useStrings, strings, errorText, type en } from "./i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import "./app.css";
type Snapshot = {
  items: Item[];
  count: number;
  lastCheck: string | null;
  errors: string[];
  authenticated: boolean;
  remaining: number | null;
};
function usePulse() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const t = useStrings();
  const reload = useCallback(() => {
    rpc.call("list").then(setData, (e) => setError(errorText(e, t)));
  }, [rpc, t]);
  useEffect(reload, [reload]);
  useRealtime("changed", reload);
  return { rpc, data, error, setError, reload };
}
function Count() {
  const { data } = usePulse();
  const t = useStrings();
  return (
    <span
      aria-label={t.attention}
      className="rp-pill rp-pill-warning font-mono"
      data-testid="pulse-count"
    >
      {data?.count ?? "…"}
    </span>
  );
}
function Notifications() {
  const t = useStrings();
  useRealtime("new-items", (payload) => {
    toast.info(
      `${t.notification}: ${Number((payload as { count?: number })?.count ?? 1)}`,
    );
  });
  return null;
}
const kindKeys = {
  issue: "kindIssue",
  pr: "kindPr",
  comment: "kindComment",
  review: "kindReview",
  ci: "kindCi",
  marketplace: "kindMarketplace",
} as const;
function statusLabel(item: Item, t: typeof en) {
  return item.status === "done" ? t.resolved : t[item.status];
}
function Settings({
  initial,
  onSaved,
}: {
  initial: Config;
  onSaved: (config: Config) => void;
}) {
  const [config, setConfig] = useState(initial);
  const [mapping, setMapping] = useState(
    JSON.stringify(initial.checkouts, null, 2),
  );
  const [repos, setRepos] = useState(initial.repositories.join("\n"));
  const [excluded, setExcluded] = useState(
    initial.excludedRepositories.join("\n"),
  );
  const [busy, setBusy] = useState(false);
  const rpc = useRpc<typeof rpcContract>();
  const context = useBbContext();
  const routeData = useRoutes();
  const t = useStrings();
  const change = (key: keyof Config, value: unknown) =>
    setConfig((current) => ({ ...current, [key]: value }));
  async function save(scan = false) {
    setBusy(true);
    try {
      const latest = await rpc.call("config");
      let value = await rpc.call("save_config", {
        ...config,
        bindings: latest.bindings,
        projectId: config.projectId || context.projectId || "",
        repositories: repos.split(/\s+/).filter(Boolean),
        excludedRepositories: excluded.split(/\s+/).filter(Boolean),
        checkouts: JSON.parse(mapping),
      });
      if (scan) {
        const checkouts = await rpc.call("scan");
        value = { ...value, checkouts };
        setMapping(JSON.stringify(checkouts, null, 2));
      }
      setConfig(value);
      onSaved(value);
      toast.success(scan ? t.scanned : t.saved);
    } catch (e) {
      toast.error(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rp-panel mt-5">
      <h2 className="rp-panel-head text-sm font-medium">{t.settings}</h2>
      <div className="rp-panel-body rp-settings">
        {(
          [
            "owner",
            "projectId",
            "hostId",
            "scanRoot",
            "parentFolderId",
            "provider",
            "model",
            "reasoning",
            "permission",
            "intervalMinutes",
          ] as const
        ).map((key) => (
          <div key={key}>
            <Label htmlFor={`rp-${key}`}>{t[key]}</Label>
            <Input
              className="mt-1"
              id={`rp-${key}`}
              type={key === "intervalMinutes" ? "number" : "text"}
              value={String(config[key])}
              onChange={(e) =>
                change(
                  key,
                  key === "intervalMinutes"
                    ? Number(e.target.value)
                    : e.target.value,
                )
              }
            />
          </div>
        ))}
        <div>
          <Label htmlFor="rp-repos">{t.repositories}</Label>
          <Textarea
            id="rp-repos"
            value={repos}
            onChange={(e) => setRepos(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="rp-excluded">{t.excludedRepositories}</Label>
          <Textarea
            id="rp-excluded"
            value={excluded}
            onChange={(e) => setExcluded(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="rp-map">{t.checkouts}</Label>
          <Textarea
            id="rp-map"
            value={mapping}
            onChange={(e) => setMapping(e.target.value)}
          />
        </div>
        {(["automatic", "marketplace"] as const).map((key) => (
          <div key={key} className="flex items-center gap-3">
            <Switch
              className="rp-switch"
              id={`rp-${key}`}
              checked={config[key]}
              onCheckedChange={(value) => change(key, value)}
            />
            <Label htmlFor={`rp-${key}`}>{t[key]}</Label>
          </div>
        ))}
        <div>
          <Label htmlFor="rp-prompt">{t.prompt}</Label>
          <Textarea
            id="rp-prompt"
            className="min-h-64"
            value={config.prompt}
            onChange={(e) => change("prompt", e.target.value)}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t.tokenHint}</p>
        <h3 className="text-sm font-medium">{t.routes}</h3>
        {routeData.error && (
          <p role="alert">{errorText(new Error(routeData.error), t)}</p>
        )}
        {routeData.routes.map((route) => (
          <RepositorySection
            key={route.repo}
            repo={route.repo}
            route={route}
            sections={routeData.sections}
            reload={routeData.reload}
          />
        ))}
        <div className="rp-actions">
          <Button disabled={busy} onClick={() => void save()}>
            {t.save}
          </Button>
          <Button
            disabled={busy}
            variant="outline"
            onClick={() => void save(true)}
          >
            {t.scan}
          </Button>
        </div>
      </div>
    </section>
  );
}
function Page() {
  const { rpc, data, error, setError, reload } = usePulse();
  const [busy, setBusy] = useState(false),
    [settings, setSettings] = useState(false),
    [config, setConfig] = useState<Config | null>(null),
    [filter, setFilter] = useState<"active" | "all" | "bots">("active"),
    [dry, setDry] = useState(false),
    [preview, setPreview] = useState("");
  const t = useStrings();
  const navigate = useBbNavigate();
  const routeData = useRoutes();
  const [reportOnly, setReportOnly] = useState(false);
  useEffect(() => {
    rpc.call("config").then(setConfig, (e) => setError(errorText(e, t)));
  }, [rpc, t, setError]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      reload();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }
  const visible = (data?.items ?? []).filter(
    (i) =>
      filter === "all" ||
      (filter === "bots"
        ? i.kind !== "ci" && (i.bot || isBot(i.author))
        : actionable(i)),
  );
  const repos = [...new Set(visible.map((i) => i.repo))];
  return (
    <div
      data-rp-content
      translate="no"
      className="h-full min-h-0 overflow-y-auto"
    >
      <div className="mx-auto w-full max-w-5xl p-4 space-y-5">
        <div className="rp-strip flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-medium">{t.title}</h1>
          <span className="rp-pill rp-pill-warning">
            {data?.count ?? "…"} {t.attention}
          </span>
          <div className="rp-actions ml-auto">
            <Button
              className="rp-accent"
              disabled={busy || dry || reportOnly}
              onClick={() =>
                void action(async () => {
                  const result = await rpc.call("batch");
                  if (result.errors.length)
                    throw Error(result.errors.join("\n"));
                })
              }
            >
              {t.batch}
            </Button>
            <Button
              variant="outline"
              className="rp-raised"
              disabled={busy}
              onClick={() => void action(() => rpc.call("refresh"))}
            >
              {t.refresh}
            </Button>
            <Button variant="ghost" onClick={() => setSettings((v) => !v)}>
              {t.settings}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {data?.authenticated ? t.auth : t.anonymous}
          {data?.lastCheck
            ? ` · ${t.last}: ${new Date(data.lastCheck).toLocaleString(t === strings() && detectLocale() === "ru" ? "ru-RU" : "en-US")}`
            : ""}
          {data?.remaining != null
            ? ` · ${t.remaining}: ${data.remaining}`
            : ""}
        </p>
        {config && (!config.hostId || !config.projectId) && (
          <p className="rp-pill rp-pill-warning">{t.unconfigured}</p>
        )}
        {routeData.error && (
          <p role="alert" className="rp-pill rp-pill-warning">
            {errorText(new Error(routeData.error), t)}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="rp-pill rp-pill-danger whitespace-pre-wrap"
          >
            {error}
          </p>
        )}
        {!!data?.errors.length && (
          <details className="rp-card p-3 text-xs">
            <summary>
              {t.errors} ({data.errors.length})
            </summary>
            <pre className="whitespace-pre-wrap">
              {data.errors.map((e) => errorText(new Error(e), t)).join("\n")}
            </pre>
          </details>
        )}
        <div className="flex flex-wrap gap-3 items-center">
          <div className="rp-seg">
            <Button
              variant="ghost"
              className="rp-seg-item"
              aria-pressed={filter === "active"}
              onClick={() => setFilter("active")}
            >
              {t.active}
            </Button>
            <Button
              variant="ghost"
              className="rp-seg-item"
              aria-pressed={filter === "all"}
              onClick={() => setFilter("all")}
            >
              {t.all}
            </Button>
            <Button
              variant="ghost"
              className="rp-seg-item"
              aria-pressed={filter === "bots"}
              onClick={() => setFilter("bots")}
            >
              {t.bots}
            </Button>
          </div>
          <Switch id="rp-dry" checked={dry} onCheckedChange={setDry} />
          <Label htmlFor="rp-dry">{t.dryMode}</Label>
          <Switch
            id="rp-report"
            checked={reportOnly}
            onCheckedChange={setReportOnly}
          />
          <Label htmlFor="rp-report">{t.reportOnly}</Label>
        </div>
        {data === null ? (
          <Skeleton className="h-32 w-full" />
        ) : repos.length === 0 ? (
          <p className="rp-card p-6 text-sm text-muted-foreground">{t.empty}</p>
        ) : (
          repos.map((repo) => (
            <section className="rp-panel" key={repo}>
              <h2 className="rp-panel-head text-sm font-medium rp-title">
                {repo}
              </h2>
              <RepositorySection
                repo={repo}
                route={routeData.routes.find((r) => r.repo === repo)}
                sections={routeData.sections}
                reload={routeData.reload}
              />
              <div className="rp-panel-body overflow-x-auto rp-items">
                <Table>
                  <TableBody>
                    {visible
                      .filter((i) => i.repo === repo)
                      .map((item) => (
                        <TableRow key={item.id}>
                          <TableCell className="min-w-48 max-w-xl whitespace-normal">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="rp-pill rp-pill-neutral">
                                {t[kindKeys[item.kind]]}
                              </span>
                              <span
                                className={`rp-pill ${item.status === "marketplace_waiting" || item.ignored ? "rp-pill-neutral" : item.status === "done" ? "rp-pill-success" : item.status === "running" ? "rp-pill-info" : "rp-pill-warning"}`}
                              >
                                {item.ignored
                                  ? t.notWatching
                                  : item.reason &&
                                      ["new", "waiting"].includes(item.status)
                                    ? t[item.reason]
                                    : statusLabel(item, t)}
                              </span>
                            </div>
                            <p className="rp-title font-medium">{item.title}</p>
                            <p className="text-xs text-muted-foreground">
                              @{item.author} · #{item.number} ·{" "}
                              {new Date(item.updated).toLocaleString(
                                detectLocale() === "ru" ? "ru-RU" : "en-US",
                              )}
                            </p>
                            <UrlLink
                              href={item.url}
                              className="text-xs underline"
                            >
                              {t.open}
                            </UrlLink>
                          </TableCell>
                          <TableCell>
                            <div className="rp-actions">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={
                                  busy ||
                                  item.ignored ||
                                  routeData.routes.find((r) => r.repo === repo)
                                    ?.status !== "ready" ||
                                  ["running", "done", "muted"].includes(
                                    item.status,
                                  )
                                }
                                onClick={() =>
                                  void action(async () => {
                                    const result = await rpc.call("run", {
                                      id: item.id,
                                      dryRun: dry,
                                      automatic: false,
                                      reportOnly,
                                    });
                                    if (dry) {
                                      setPreview(result.prompt);
                                      toast.success(t.previewReady);
                                    } else if (result.threadId)
                                      navigate.toThread(result.threadId);
                                  })
                                }
                              >
                                {t.run}
                              </Button>
                              {item.threadId && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    navigate.toThread(item.threadId!)
                                  }
                                >
                                  {t.thread}
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy || item.status === "running"}
                                onClick={() =>
                                  void action(() =>
                                    rpc.call("mark", {
                                      id: item.id,
                                      status:
                                        item.status === "done" ? "new" : "done",
                                    }),
                                  )
                                }
                              >
                                {item.status === "done" ? t.restore : t.done}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy || item.status === "running"}
                                onClick={() =>
                                  void action(() =>
                                    rpc.call("mark", {
                                      id: item.id,
                                      status:
                                        item.status === "muted"
                                          ? "new"
                                          : "muted",
                                    }),
                                  )
                                }
                              >
                                {item.status === "muted" ? t.restore : t.mute}
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          ))
        )}
        {preview && (
          <details open className="rp-card p-4">
            <summary>{t.preview}</summary>
            <pre className="text-xs whitespace-pre-wrap break-words">
              {preview}
            </pre>
          </details>
        )}
        {settings && config && (
          <Settings initial={config} onSaved={setConfig} />
        )}
      </div>
    </div>
  );
}
export default definePluginApp((app) => {
  app.contentScripts.register({ id: "locale", mount: mountChromeLocalization });
  app.slots.navPanel({
    id: "pulse",
    title: strings().title,
    icon: "Activity",
    path: "pulse",
    component: Page,
    headerContent: Count,
  });
  app.slots.experimental_appOverlay({
    id: "notifications",
    component: Notifications,
  });
});
