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
