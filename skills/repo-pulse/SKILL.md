---
name: repo-pulse
description: Inspect Repo Pulse GitHub attention items and validate or launch linked agents using the bb repo-pulse CLI.
---

# Repo Pulse

Use `bb repo-pulse list --json` or the read-only `repo_pulse_list` tool (limit 1–50). `bb repo-pulse refresh` polls configured public GitHub repositories, external comments/reviews, default-branch CI and owner marketplace submissions. No model is called by polling.

Use `bb repo-pulse run <item-id> --dry-run` to validate the checkout and inspect the contract without creating a thread. Remove `--dry-run` only when the user requests a real agent. The plugin groups new items for that repository and refuses another linked active writer. The UI supports process-all-new, done and mute. Do not start writers in a checkout occupied by unrelated work: Repo Pulse owns only its linked thread locks.

The Repo Pulse page selects owner, repository list, project, host, scan folder, checkout map, provider/model/reasoning/permissions, polling interval, editable contract and automatic mode (off by default). Automatic mode requires reports and local branches only; publishing, merging and public replies require explicit owner approval. Never post messages merely because an item exists.

GitHub credentials remain server-side: secret `githubToken` or Env Catalog `GH_TOKEN`. Never print credentials or copy them into files. Anonymous polling has a persistent 45-request hourly budget. Poll errors do not prove items were closed. The attention count uses the native panel header because SDK sidebar accessories are not mounted by BB.
