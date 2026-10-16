import { useEffect, useState, useCallback } from "react";
import { useRpc, useRealtime } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Route, Section } from "./sections";
import { sectionLabel } from "./sections";
import { useStrings, errorText } from "./i18n";
import { Button } from "./components/ui/button";
import { Label } from "./components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./components/ui/select";
import { toast } from "sonner";
export function useRoutes() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<{ routes: Route[]; sections: Section[] }>({
    routes: [],
    sections: [],
  });
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    rpc.call("routes").then(
      (value) => {
        setData(value);
        setError("");
      },
      () => setError("foldersUnavailable"),
    );
  }, [rpc]);
  useEffect(reload, [reload]);
  useRealtime("changed", reload);
  return { ...data, reload, error };
}
export function RepositorySection({
  repo,
  route,
  sections,
  reload,
}: {
  repo: string;
  route?: Route;
  sections: Section[];
  reload: () => void;
}) {
  const t = useStrings(),
    rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  async function act(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await fn();
      reload();
      setEditing(false);
      toast.success(message);
    } catch (e) {
      toast.error(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="px-3 pb-3 space-y-2 text-xs" data-rp-binding={repo}>
      <p className="flex flex-wrap items-center gap-1">
        {t.section}: <span>{route?.label || t.noSection}</span> ·
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={() => setEditing((v) => !v)}
          aria-expanded={editing}
        >
          {t.editSection}
        </Button>
      </p>
      {editing && (
        <>
          <p className="rp-title text-muted-foreground">
            {t.checkout}: {route?.checkoutPath || t.configureCheckout}
          </p>
          <div className="flex flex-wrap gap-2 items-center">
            <Label className="sr-only" htmlFor={`rp-section-${repo}`}>
              {t.selectSection}
            </Label>
            <Select
              disabled={busy}
              value={route?.folderId ?? "auto"}
              onValueChange={(folderId) =>
                void act(
                  () =>
                    rpc.call("bind_section", {
                      repo,
                      folderId: folderId === "auto" ? null : folderId,
                    }),
                  t.bindingSaved,
                )
              }
            >
              <SelectTrigger
                id={`rp-section-${repo}`}
                className="w-full max-w-md"
                aria-label={`${t.section}: ${repo}`}
              >
                <SelectValue placeholder={t.selectSection} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t.automaticSection}</SelectItem>
                {sections
                  .filter(
                    (s) => s.kind === "folder" && s.hostId === route?.hostId,
                  )
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {sectionLabel(s, sections)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {route?.status !== "ready" && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !route?.checkoutPath}
                onClick={() =>
                  void act(
                    () => rpc.call("create_section", { repo }),
                    t.sectionCreated,
                  )
                }
              >
                {t.createSection}
              </Button>
            )}
          </div>
        </>
      )}
      {!editing && route?.status !== "ready" && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !route?.checkoutPath}
          onClick={() =>
            void act(
              () => rpc.call("create_section", { repo }),
              t.sectionCreated,
            )
          }
        >
          {t.createSection}
        </Button>
      )}
      {route && route.status !== "ready" && (
        <p className="rp-pill rp-pill-warning">{t[route.status]}</p>
      )}
    </div>
  );
}
