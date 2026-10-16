import { it, expect } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { configSchema } from "../core";
it("classifies all five PRs equally, caches completed evidence, and surfaces other failures even for a disabled plugin", async () => {
  const original = globalThis.fetch;
  const numbers = [582, 583, 584, 585, 588];
  let mode = "gate",
    revision = 1,
    logRequests = 0;
  globalThis.fetch = async (input) => {
    const u = new URL(String(input)),
      p = u.pathname;
    let data: any = [];
    if (p === "/search/issues")
      data = {
        items: numbers.map((number) => ({
          id: number,
          number,
          state: "open",
          title: `Update ${number}`,
          html_url: `https://github.com/get-bb/marketplace/pull/${number}`,
          user: { login: "owner" },
          updated_at: "2026-10-16",
        })),
      };
    else if (p.match(/\/pulls\/\d+$/)) {
      const n = p.split("/").pop();
      data = {
        head: { sha: `sha${n}`, repo: { full_name: "owner/marketplace" } },
      };
    } else if (p.endsWith("/files")) {
      const n = p.split("/").at(-2);
      data = [{ filename: `entries/${n}.json` }];
    } else if (p.includes("/contents/entries/")) {
      const n = p.split("/").pop()?.split(".")[0];
      data = {
        encoding: "base64",
        content: Buffer.from(
          JSON.stringify({
            source: {
              git: { url: `https://github.com/owner/bb-plugin-${n}.git` },
            },
          }),
        ).toString("base64"),
      };
    } else if (p.endsWith("/check-runs")) {
      const n = Number(p.match(/sha(\d+)/)?.[1]);
      data = {
        check_runs: [
          {
            id: n,
            name: "validate",
            conclusion: "failure",
            completed_at: `2026-10-16T${revision}:00Z`,
            details_url: `https://github.com/get-bb/marketplace/actions/runs/${n}/job/${n}`,
          },
        ],
      };
    } else if (p.endsWith("/status"))
      data = { state: mode === "status" ? "failure" : "pending" };
    else if (p.endsWith("/annotations"))
      data = [
        {
          annotation_level: "failure",
          message: "Process completed with exit code 1.",
        },
      ];
    else if (p.match(/\/actions\/jobs\/\d+$/))
      data = {
        steps: [
          { name: "Run npm run gate:v1", conclusion: "failure" },
          ...(mode === "schema" && p.endsWith("/582")
            ? [{ name: "Validate entry schema", conclusion: "failure" }]
            : []),
        ],
      };
    else if (p.endsWith("/logs")) {
      logRequests++;
      if (mode === "unavailable" && p.includes("/582/"))
        return new Response("unavailable", { status: 403 });
      return new Response(
        'Frozen v1 entries changed.\nAdd the "v1-change" label if the change is intentional.',
      );
    }
    return new Response(JSON.stringify(data));
  };
  const h = createFakePluginHost({
    pluginId: "repo-pulse",
    settings: { githubToken: "test" },
    sdk: {
      plugins: {
        list: async () => ({
          plugins: numbers.map(
            (n) =>
              ({
                id: String(n),
                enabled: ![582, 584].includes(n),
                source: `git:https://github.com/owner/bb-plugin-${n}.git@^0.1.0`,
              }) as any,
          ),
        }),
      },
    },
  });
  try {
    await plugin(h.bb);
    await h.harness.behavior.callRpc(
      "save_config",
      configSchema.parse({ owner: "owner" }),
    );
    let d: any = await h.harness.behavior.callRpc("refresh", null);
    expect(d.errors).toEqual([]);
    expect(d.count).toBe(0);
    expect(d.items).toHaveLength(5);
    expect(
      d.items.every(
        (i: any) => i.status === "maintainer_waiting" && !i.ignored,
      ),
    ).toBe(true);
    expect(logRequests).toBe(5);
    await h.harness.behavior.callRpc("mark", {
      id: d.items[0].id,
      status: "done",
    });
    await h.harness.behavior.callRpc("mark", {
      id: d.items[0].id,
      status: "new",
    });
    expect(
      ((await h.harness.behavior.callRpc("list", null)) as any).count,
    ).toBe(0);
    await expect(
      h.harness.behavior.callRpc("run", { id: d.items[0].id, dryRun: true }),
    ).rejects.toThrow("maintainer_waiting");
    expect(await h.harness.behavior.callRpc("batch", null)).toEqual({
      threads: [],
      errors: [],
    });
    d = await h.harness.behavior.callRpc("refresh", null);
    expect(logRequests).toBe(5);
    expect(d.items.every((i: any) => i.status === "maintainer_waiting")).toBe(
      true,
    );
    mode = "schema";
    revision++;
    d = await h.harness.behavior.callRpc("refresh", null);
    expect(d.count).toBe(1);
    expect(d.items.find((i: any) => i.number === 582)).toMatchObject({
      status: "new",
      reason: "checksFailed",
      ignored: false,
    });
    mode = "unavailable";
    revision++;
    d = await h.harness.behavior.callRpc("refresh", null);
    expect(d.count).toBe(1);
    expect(d.errors).toEqual([
      "get-bb/marketplace #582: gateEvidenceUnavailable",
    ]);
    mode = "status";
    revision++;
    d = await h.harness.behavior.callRpc("refresh", null);
    expect(d.count).toBe(5);
    expect(h.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  } finally {
    globalThis.fetch = original;
    await h.harness.lifecycle.dispose();
  }
});
