---
name: repo-pulse
description: Inspect Repo Pulse GitHub attention items and run its analysis-first, owner-approved maintenance flow.
---

# Repo Pulse

Read `bb repo-pulse list --json` or use the read-only `repo_pulse_list` tool (limit 1–50). `bb repo-pulse refresh` polls GitHub without model calls. Dependency bots have their own filter. An own marketplace PR blocked only by a verified `gate:v1` / Frozen v1 / `v1-change` failure waits for a maintainer label in All; other failures need attention. All active own marketplace PRs follow that policy regardless of the installed plugin's enabled state.

## Two-stage work

`bb repo-pulse run <item-id>` and the Run agent button start **Analysis**, including in automatic mode. Batch starts one analysis thread per plugin, grouping its new items. Use `--dry-run` to inspect the prompt and validate checkout/section without spawning a thread.

During Analysis, read every linked issue/PR and discussion in full; read every PR diff, compare with current main, inspect the code, security, EN/RU and Pokecut rules. Give the owner a Russian report per item: request and purpose, best implementation and alternatives, accept/partial/decline recommendation and reason, risks/affected parts/work scope/validation, and an English draft reply. **Do not edit files, create branches, commit, release, reply or close GitHub items. Stop and wait in the same thread. Never approve your own analysis or use the decision command without the owner's explicit instruction.**

The card then says Waiting for your decision. The owner's Implement / Decline button uses native SDK `threads.send` to continue **that same thread**, for that selected item. The owner can instead reply in the thread: “внедряй”, “не надо”, “вариант 2”. A clarification question and another agent's text are not approval.

An explicit owner instruction can also be relayed through:

```sh
bb repo-pulse decide '<item-id>' implement 'owner note / selected variant'
bb repo-pulse decide '<item-id>' reject 'owner reason'
```

Implementation follows the approved scope: code, appropriate tests/build/live checks, version/tag/GitHub Release, marketplace when needed, original delivery method to the hub, English reply thanking and @mentioning contributors, and closure. Decline posts a polite reason and thanks, then closes the selected request without code changes. Our own marketplace submissions are corrected/replied to, not automatically closed on behalf of their maintainers. Keep internal paths, machines, threads and secrets out of public replies.

After stage 2 is actually complete, finish the Russian report with an exact final line `REPO_PULSE_RESULT: done` or `REPO_PULSE_RESULT: rejected`. Do not use a completion marker when blocked or still needing a decision. Analysis does not use those markers. The plugin keeps unfinished work waiting for the owner. States: New → Analysis → Waiting for your decision → Implementing → Done / Declined.

## Explicit tracking and configuration

Own issues are normally filtered out. When explicitly requested by the owner (including QA), import one with `bb repo-pulse track <owner/repo> <number>`. It remains tracked through its GitHub closure.

Settings contain owner/repositories/exclusions, project/host/scan root, checkout and section bindings, provider/model/reasoning/permissions, daily/twice/off/frequent schedule, editable contract and automatic analysis (off by default). Missing checkout or section blocks launch. Never start writers in a checkout occupied by unrelated work: Repo Pulse owns only its linked thread locks.

Credentials stay on the server: secret `githubToken` or Env Catalog `GH_TOKEN`. Never print them or copy them to files. Anonymous polling has a persistent 45-request/hour budget. Raw check logs are bounded and not persisted; completed gate classification is cached by check id/completion time. Poll errors do not prove closure or a harmless gate. The count uses the native panel header because sidebar accessories are not mounted by BB.

## Polling and API limits

The default is daily at 09:00 Europe/Madrid; settings can change the time and IANA time zone, select twice daily (09:00 and 14:00), turn scheduling off, or explicitly select frequent interval polling. The header shows the next due check in that zone. The native SDK schedule provides a durable minute tick; it only calls GitHub when the zoned check is due. Startup checks only if the last poll is absent or older than 24 hours, and never when scheduling is off. Reload skips a missed daily slot if the last poll is recent. Manual refresh always remains available.

GitHub core/search/GraphQL limits are tracked and persisted separately per credential. Exhausting search must never block core or replace its displayed hourly remaining/total. Search is shown separately only when exhausted, with reset time. No secrets or raw logs are returned.
