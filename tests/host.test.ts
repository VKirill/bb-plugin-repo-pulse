import { describe, it, expect } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import entry from "../host";
describe("host checkout validation", () => {
  it("accepts only the actual git root with the expected GitHub origin", async () => {
    const temp = await mkdtemp(join(tmpdir(), "repo-pulse-host-"));
    const root = await realpath(temp);
    const harness = experimental_createHostEntryHarness(entry);
    try {
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", [
        "-C",
        root,
        "remote",
        "add",
        "origin",
        "https://github.com/owner/repo.git",
      ]);
      await mkdir(join(root, "nested"));
      await expect(
        harness.experimental_call("inspect", {
          path: root,
          repo: "owner/repo",
        }),
      ).resolves.toEqual({ path: root });
      await expect(
        harness.experimental_call("inspect", {
          path: join(root, "nested"),
          repo: "owner/repo",
        }),
      ).rejects.toThrow("checkoutInvalid");
      await expect(
        harness.experimental_call("inspect", {
          path: root,
          repo: "owner/other",
        }),
      ).rejects.toThrow("checkoutInvalid");
    } finally {
      await harness.experimental_dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
