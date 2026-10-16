import {
  experimental_defineHostEntry,
  defineRpcContract,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { readdir, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { repoFromRemote } from "./core";
export const hostContract = defineRpcContract({
  scan: {
    input: z.object({ root: z.string().min(1) }),
    output: z.record(z.string(), z.string()),
  },
});
const exec = promisify(execFile);
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    scan: async ({ root }, ctx) => {
      const canonical = await realpath(root);
      const map: Record<string, string> = {};
      const entries = await readdir(canonical, { withFileTypes: true });
      if (entries.length > 1000) throw Error("Scan root too large");
      for (const entry of entries) {
        ctx.signal.throwIfAborted();
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const directory = path.join(canonical, entry.name);
        try {
          const { stdout } = await exec(
            "git",
            ["-C", directory, "config", "--get", "remote.origin.url"],
            { timeout: 5000, maxBuffer: 8192, signal: ctx.signal },
          );
          const repo = repoFromRemote(stdout);
          if (repo && (!map[repo] || entry.name === repo.split("/")[1]))
            map[repo] = directory;
        } catch {}
      }
      return map;
    },
  },
});
