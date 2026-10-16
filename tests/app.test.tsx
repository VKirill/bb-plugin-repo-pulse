// @vitest-environment jsdom
import { it, expect, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { configSchema } from "../core";
import { toast } from "sonner";
import { ru } from "../messages";
it("renders Russian BB and blocks bulk dispatch while report-only is selected", async () => {
  document.documentElement.lang = "en";
  document.documentElement.setAttribute("data-pk-lang", "ru");
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(
    app.navPanels[0],
    { subPath: "" },
    {
      rpc: {
        list: () => ({
          items: [],
          count: 0,
          lastCheck: null,
          errors: [],
          authenticated: true,
          remaining: 100,
        }),
        config: () => configSchema.parse({}),
        routes: () => ({ sections: [], routes: [] }),
      },
    },
  );
  try {
    const batch = await slot.findByRole("button", { name: ru.batch });
    expect((batch as HTMLButtonElement).disabled).toBe(false);
    expect(slot.getByRole("heading", { name: ru.title })).toBeTruthy();
    fireEvent.click(slot.getByRole("switch", { name: ru.reportOnly }));
    expect((batch as HTMLButtonElement).disabled).toBe(true);
    expect(
      slot.inspection.rpcCalls.some((call: any) => call.method === "batch"),
    ).toBe(false);
  } finally {
    slot.lifecycle.unmount();
    document.documentElement.removeAttribute("data-pk-lang");
  }
});

it("uses the Russian dictionary for BB realtime notifications", async () => {
  document.documentElement.lang = "en";
  document.documentElement.setAttribute("data-pk-lang", "ru");
  const app = await loadPluginApp(() => import("../app"));
  const spy = vi.spyOn(toast, "info");
  const slot = renderSlot(app.appOverlays[0], {});
  try {
    await slot.behavior.emitRealtime("new-items", { count: 2 });
    expect(spy).toHaveBeenCalledWith(`${ru.notification}: 2`);
  } finally {
    slot.lifecycle.unmount();
    spy.mockRestore();
    document.documentElement.removeAttribute("data-pk-lang");
  }
});

it("keeps calm marketplace/bot/disabled groups out of attention and reveals section chooser only on demand", async () => {
  document.documentElement.lang = "ru-RU";
  const app = await loadPluginApp(() => import("../app"));
  const base = {
    number: 1,
    title: "A request",
    author: "VKirill",
    url: "https://github.com/get-bb/marketplace/pull/1",
    updated: "2026-10-16",
    fingerprint: "one",
    closed: false,
  };
  const slot = renderSlot(
    app.navPanels[0],
    { subPath: "" },
    {
      rpc: {
        list: () => ({
          items: [
            {
              ...base,
              id: "market",
              repo: "VKirill/plugin",
              kind: "marketplace",
              status: "marketplace_waiting",
            },
            {
              ...base,
              id: "bot",
              repo: "VKirill/bots",
              kind: "pr",
              author: "dependabot[bot]",
              bot: true,
              status: "new",
            },
            {
              ...base,
              id: "disabled",
              repo: "VKirill/agency",
              kind: "ci",
              ignored: true,
              status: "waiting",
            },
          ],
          count: 0,
          lastCheck: null,
          errors: [],
          authenticated: true,
          remaining: 10,
        }),
        config: () => configSchema.parse({}),
        routes: () => ({
          sections: [],
          routes: [
            {
              repo: "VKirill/plugin",
              projectId: "p",
              hostId: "h",
              checkoutPath: "/work/plugin",
              folderId: "f",
              label: "Плагины / plugin",
              status: "ready",
            },
          ],
        }),
      },
    },
  );
  try {
    await slot.findByText(ru.empty);
    expect(slot.queryByRole("heading", { name: "VKirill/plugin" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: ru.all }));
    await slot.findByText(ru.marketplace_waiting);
    expect(slot.queryAllByRole("columnheader")).toHaveLength(0);
    expect(slot.queryAllByRole("combobox")).toHaveLength(0);
    fireEvent.click(slot.getAllByRole("button", { name: ru.editSection })[0]);
    expect(slot.getAllByRole("combobox")).toHaveLength(1);
    fireEvent.click(slot.getByRole("button", { name: ru.bots }));
    expect(slot.getByRole("heading", { name: "VKirill/bots" })).toBeTruthy();
    expect(slot.queryByRole("heading", { name: "VKirill/plugin" })).toBeNull();
  } finally {
    slot.lifecycle.unmount();
    document.documentElement.lang = "en";
  }
});
