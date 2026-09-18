# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the major version is `0`, the frontmatter contract in
[`docs/SPEC.md`](docs/SPEC.md) may change in a minor release. Any such change will be
called out here under **Changed**, with what it does to documents already in the wild.

## [Unreleased]

### Added

- **A moved folder is now found.** When a doc's `describes` glob matches nothing but used
  to, kontext asks git where those files went and adds one finding under the `orphaned`
  verdict, for example: update `describes` from `src/auth/**` to `src/identity/**`.
  It only suggests a new glob when more than half of the files moved to one place, and
  says "cannot tell" when git cannot link them. `check --fix-hints` names the change and
  `doctor` raises it as its own finding.
- `DriftEvidence.relocations` in the JSON output carries the same evidence for tools.

### Unchanged on purpose

- Verdicts, scores and commit counts. kontext suggests the new glob; it does not edit
  the doc, and it does not add the old paths to the staleness count. The reasoning is in
  [`docs/SPEC.md`](docs/SPEC.md#decided-rename-tracking).

## [0.1.0] — 2026-09-01

First published release. Everything below already existed in the repository; this is
the version that ships to npm as `@patkusch/kontext`.

### Added

- **Staleness proven from git, not guessed.** A document declares `describes:` globs;
  git answers whether that code moved after the document last did. No LLM in the
  staleness path, so the verdict is deterministic and CI can gate on it.
- **Six verdicts** — `fresh`, `drifting`, `stale`, `expired`, `orphaned`, `superseded`,
  plus `unverified` for the honest middle where nothing can be proven either way.
  Every verdict carries evidence: a commit, a date, a glob, or a file count. A bare
  "stale" with no receipt is treated as a bug.
- **CLI** — `check`, `map`, `pack`, `init`, `handoff`, `doctor`.
  - `doctor` works on any repository with zero setup and zero frontmatter.
  - `pack` assembles a context bundle for an agent under a token budget, freshest first.
  - `handoff` writes session state so the next session starts where the last one stopped.
- **MCP server** (`kontext-mcp`) exposing 7 freshness-aware tools, so an agent can ask
  what is current instead of slurping the whole repository into its context window.
- **Conflict detection** between documents that make contradictory claims about the
  same code.
- Zero runtime dependencies outside the MCP SDK.

### Fixed

- `init` refused to run where the repository root resolved wider than intended. A
  project folder with no `.git` of its own makes `findRepoRoot` walk upward; on a
  machine where `$HOME` is itself a git repository, `init --yes` would have rewritten
  3,562 markdown files across the entire home directory. `init` now warns on
  `--dry-run` and refuses on `--yes` when the root is the home directory or the corpus
  exceeds 400 documents. `--force` overrides.
- Vendored dependency documentation is excluded by default. Run against a real Python
  project, kontext reported 13 documents and 3 contradictions — but 12 of those
  documents were `LICENSE`/`README` files inside `.venv`, and all 3 contradictions were
  identical third-party licences noticing that they matched each other. The defaults
  knew only about `node_modules`; they now cover Python (`.venv`, `venv`,
  `site-packages`, `__pycache__`, `.tox`, `*.egg-info`), JS framework caches (`.next`,
  `.nuxt`, `.svelte-kit`, `.turbo`, `bower_components`), `Pods`, `.terraform`,
  `.gradle`, `coverage` and `.cache`. User excludes are unioned with these rather than
  replacing them, so they cannot be lost by overriding the config.
- `verify` is specified as a shell command but was executed without a shell, so
  builtins, pipes and `&&` failed with a misleading `ENOENT`. It now runs with
  `shell: true`, which also selects the right shell per platform.
- `freshness.ts` contained raw NUL/SOH bytes inside string literals, which made the
  file read as binary to git, grep, diff and GitHub's viewer. Replaced with escape
  sequences.
- `.kontext/**` is excluded by default. A generated handoff carries `ttlDays: 7`, so
  kontext managing its own output would have failed the repository's CI a week later.

### Known limitations

- Staleness is proven against **git history**, so a repository with a squashed or
  rewritten history will under-report drift.
- `describes:` globs are matched against tracked files only. Untracked code is
  invisible to the drift check, by design.

[Unreleased]: https://github.com/patkusch/kontext/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/patkusch/kontext/releases/tag/v0.1.0
