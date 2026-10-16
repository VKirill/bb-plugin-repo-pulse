# Changelog

## 0.1.1 — 2026-10-16

- Abort in-flight GitHub polling when the background service stops; an interrupted poll never starts automatic agents.

## 0.1.0 — 2026-10-16

- Initial release: GitHub PRs, issues, comments, reviews, default-branch CI failures and owner marketplace submissions.
- ETag polling, persistent item state, checkout discovery on an explicit BB host, grouped agent dispatch, lifecycle tracking and automatic report/branch mode (off by default).
- English and Russian native BB interface, Pokecut surfaces, header attention count, Sonner notifications, CLI, read-only agent tool and safe launch preview.
- No core changes; sidebar count replaced by the native panel header because the SDK accessory is not mounted by BB.
