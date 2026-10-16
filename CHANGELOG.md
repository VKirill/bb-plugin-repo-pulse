# Changelog

## 0.1.4 — 2026-10-16

- Translate the host-rendered empty GitHub secret placeholder on Repo Pulse’s own settings page.

## 0.1.3 — 2026-10-16

- Disable bulk dispatch while read-only report mode is selected; verify the actual Russian page in the SDK UI harness.
- Localize native secret labels only on Repo Pulse’s own settings page.
- Live verification: report agent filed under Plugins / Agency, ran in the repository root, returned a read-only CI report and was stopped.

## 0.1.2 — 2026-10-16

- Follow BB’s Russian interface when the Russifier leaves html lang as English; localize the entire page, header, settings, notifications and own plugin labels. Add dictionary coverage and JSX checks.
- Match each repository to its Projects & Sections folder; show and edit section bindings, create missing sections, validate checkout roots and GitHub origins, and file each spawned thread into the selected section.
- Add read-only report launches and stop the agent if section placement fails.
- Distribute from public GitHub semver tags for managed hub updates.

## 0.1.1 — 2026-10-16

- Abort in-flight GitHub polling when the background service stops; an interrupted poll never starts automatic agents.

## 0.1.0 — 2026-10-16

- Initial release: GitHub PRs, issues, comments, reviews, default-branch CI failures and owner marketplace submissions.
- ETag polling, persistent item state, checkout discovery on an explicit BB host, grouped agent dispatch, lifecycle tracking and automatic report/branch mode (off by default).
- English and Russian native BB interface, Pokecut surfaces, header attention count, Sonner notifications, CLI, read-only agent tool and safe launch preview.
- No core changes; sidebar count replaced by the native panel header because the SDK accessory is not mounted by BB.
