import { describe, it, expect } from "vitest";
import {
  Github,
  configSchema,
  githubItem,
  mergeItem,
  threadStatus,
  buildPrompt,
  repoFromRemote,
  type CacheEntry,
} from "../core";
const item = githubItem("VKirill/bb-plugin-test", "issue", {
  id: 1,
  number: 2,
  user: { login: "helper" },
  title: "Fix",
  html_url: "https://github.com/VKirill/bb-plugin-test/issues/2",
  updated_at: "2026-10-16",
  state: "open",
});
describe("polling state", () => {
  it("deduplicates and reopens an updated read item", () => {
    const read = { ...item, status: "done" as const, seen: item.fingerprint };
    expect(mergeItem(read, item).status).toBe("done");
    expect(mergeItem(read, { ...item, fingerprint: "changed" }).status).toBe(
      "new",
    );
  });
  it("keeps muted items quiet but resolves closed items", () => {
    expect(
      mergeItem(
        { ...item, status: "muted" },
        { ...item, fingerprint: "changed" },
      ).status,
    ).toBe("muted");
    expect(mergeItem(item, { ...item, closed: true }).status).toBe("done");
  });
  it("preserves a running thread across new comments and close events", () => {
    const running = {
      ...item,
      status: "running" as const,
      threadId: "thr_test",
    };
    expect(mergeItem(running, { ...item, fingerprint: "next" })).toMatchObject({
      status: "running",
      threadId: "thr_test",
    });
    expect(threadStatus({ ...running, closed: true }, false).status).toBe(
      "done",
    );
    expect(threadStatus(running, false).status).toBe("waiting");
  });
  it("sends ETag, consumes 304 cached result and never caches secrets or bodies", async () => {
    const map = new Map<string, CacheEntry>();
    const requests: RequestInit[] = [];
    const responses = [
      new Response(
        JSON.stringify([
          { id: 1, title: "a", body: "private", user: { login: "x" } },
        ]),
        { headers: { ETag: '"one"' } },
      ),
      new Response(null, { status: 304 }),
    ];
    const api = new Github(
      "secret",
      {
        get: async (k) => map.get(k),
        set: async (k, v) => {
          map.set(k, v);
        },
      },
      async (_url, init) => {
        requests.push(init!);
        return responses.shift()!;
      },
    );
    expect(await api.get("/test")).toEqual([
      { id: 1, title: "a", user: { login: "x" } },
    ]);
    expect(await api.get("/test")).toEqual([
      { id: 1, title: "a", user: { login: "x" } },
    ]);
    expect(
      (requests[1].headers as Record<string, string>)["If-None-Match"],
    ).toBe('"one"');
    expect(JSON.stringify([...map.values()])).not.toContain("secret");
    expect(JSON.stringify([...map.values()])).not.toContain("private");
  });
  it("enforces a shared anonymous hourly budget before a request", async () => {
    let called = false;
    const api = new Github(
      undefined,
      { get: async () => undefined, set: async () => {} },
      async () => {
        called = true;
        throw Error("unexpected");
      },
      { used: 45, reset: Date.now() + 10000 },
    );
    await expect(api.get("/test")).rejects.toThrow("anonymousLimit");
    expect(called).toBe(false);
  });
});
describe("checkout and prompt policy", () => {
  it.each([
    "https://github.com/VKirill/bb-plugin-test.git",
    "git@github.com:VKirill/bb-plugin-test.git",
    "ssh://git@github.com/VKirill/bb-plugin-test.git",
  ])("parses origin %s", (remote) =>
    expect(repoFromRemote(remote)).toBe("VKirill/bb-plugin-test"),
  );
  it("refuses non GitHub origins", () =>
    expect(repoFromRemote("https://evil.test/VKirill/test.git")).toBeNull());
  it("substitutes contract data and adds automatic restriction after it", () => {
    const c = configSchema.parse({
      prompt:
        "{{repo}} {{checkoutPath}} {{itemUrl}} {{itemKind}} {{itemNumber}} {{author}}",
    });
    const prompt = buildPrompt(c, [item], "/work/test", true);
    expect(prompt).toContain("VKirill/bb-plugin-test /work/test");
    expect(prompt).not.toContain("{{");
    expect(prompt).toContain("Do not merge, release, push");
    expect(
      prompt.endsWith(
        "This restriction overrides permissions in the contract.",
      ),
    ).toBe(true);
  });
});
