import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { configSchema } from "../core";
import { nextCheck, startupDue, scheduleSchema } from "../schedule";
import plugin from "../server";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("zoned daily schedule", () => {
  it("migrates the old interval config to daily 09:00 Madrid, and validates inputs", () => {
    expect(configSchema.parse({ intervalMinutes: 15 }).schedule).toEqual({
      mode: "daily",
      time: "09:00",
      secondTime: "14:00",
      timeZone: "Europe/Madrid",
    });
    expect(scheduleSchema.safeParse({ time: "25:00" }).success).toBe(false);
    expect(scheduleSchema.safeParse({ timeZone: "not/a-zone" }).success).toBe(
      false,
    );
  });
  it.each([
    ["2026-10-24T08:00:00Z", "2026-10-25T08:00:00.000Z"],
    ["2026-03-28T09:00:00Z", "2026-03-29T07:00:00.000Z"],
    ["2026-10-17T06:59:30Z", "2026-10-17T07:00:00.000Z"],
    ["2026-10-17T07:00:00Z", "2026-10-18T07:00:00.000Z"],
  ])("keeps 09:00 local across DST (%s)", (after, expected) => {
    expect(nextCheck(scheduleSchema.parse({}), 15, Date.parse(after))).toBe(
      expected,
    );
  });
  it("supports two custom times, off, and an explicitly selected frequent interval", () => {
    const after = Date.parse("2026-10-17T07:00:00Z");
    expect(nextCheck(scheduleSchema.parse({ mode: "twice" }), 15, after)).toBe(
      "2026-10-17T12:00:00.000Z",
    );
    expect(
      nextCheck(
        scheduleSchema.parse({ time: "10:15", timeZone: "UTC" }),
        15,
        after,
      ),
    ).toBe("2026-10-17T10:15:00.000Z");
    expect(
      nextCheck(scheduleSchema.parse({ mode: "off" }), 15, after),
    ).toBeNull();
    expect(
      nextCheck(scheduleSchema.parse({ mode: "frequent" }), 15, after),
    ).toBe("2026-10-17T07:15:00.000Z");
    expect(startupDue("2026-10-16T07:00:00Z", after)).toBe(false);
    expect(startupDue("2026-10-16T06:59:59Z", after)).toBe(true);
  });
});

async function host(lastCheck: string | null, mode = "daily") {
  const fetcher = vi.fn(async () => new Response("[]"));
  vi.stubGlobal("fetch", fetcher);
  let h = createFakePluginHost({
    pluginId: "repo-pulse",
    settings: { githubToken: "test-only" },
    sdk: { plugins: { list: async () => ({ plugins: [] }) } },
  });
  await h.bb.storage.kv.set(
    "config",
    configSchema.parse({
      projectId: "p",
      owner: "owner",
      repositories: ["owner/repo"],
      marketplace: false,
      schedule: { mode },
    }),
  );
  await h.bb.storage.kv.set("meta", {
    lastCheck,
    errors: [],
    authenticated: true,
    remaining: 29,
  });
  await plugin(h.bb);
  return { h, fetcher };
}

describe("native scheduled polling lifecycle", () => {
  it("makes no request on recent startup/reload or an early tick, then polls once at 09:00", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T06:50:00Z"));
    let { h, fetcher } = await host("2026-10-17T06:00:00Z");
    try {
      expect(h.harness.registrations.schedules).toHaveLength(1);
      await h.harness.behavior.runService("startup").done;
      h = await h.harness.lifecycle.reload(plugin);
      await h.harness.behavior.runService("startup").done;
      await h.harness.behavior.runSchedule("poll");
      expect(fetcher).not.toHaveBeenCalled();
      expect(await h.harness.behavior.callRpc("list", null)).toMatchObject({
        remaining: null,
        nextCheck: "2026-10-17T07:00:00.000Z",
        timeZone: "Europe/Madrid",
      });
      vi.setSystemTime(new Date("2026-10-17T07:00:00Z"));
      await h.harness.behavior.runSchedule("poll");
      expect(fetcher).toHaveBeenCalled();
      const count = fetcher.mock.calls.length;
      await h.harness.behavior.runSchedule("poll");
      expect(fetcher).toHaveBeenCalledTimes(count);
      expect(await h.harness.behavior.callRpc("list", null)).toMatchObject({
        nextCheck: "2026-10-18T07:00:00.000Z",
      });
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("checks on stale startup, but an off schedule only checks on manual refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T06:50:00Z"));
    const { h, fetcher } = await host("2026-10-15T06:00:00Z");
    try {
      await h.harness.behavior.runService("startup").done;
      expect(fetcher).toHaveBeenCalled();
    } finally {
      await h.harness.lifecycle.dispose();
    }
    const off = await host(null, "off");
    try {
      await off.h.harness.behavior.runService("startup").done;
      await off.h.harness.behavior.runSchedule("poll");
      expect(off.fetcher).not.toHaveBeenCalled();
      expect(await off.h.harness.behavior.callRpc("list", null)).toMatchObject({
        nextCheck: null,
      });
      await off.h.harness.behavior.callRpc("refresh", null);
      expect(off.fetcher).toHaveBeenCalled();
    } finally {
      await off.h.harness.lifecycle.dispose();
    }
  });
});
