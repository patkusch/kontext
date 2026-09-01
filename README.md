<h1 align="center">kontext</h1>

<p align="center">
  <strong>Your markdown has no lifecycle. That's the bug.</strong>
</p>

<p align="center">
  kontext gives context documents one — so you can prove which docs are stale,<br/>
  pack fresh context for agents, and hand off state between sessions.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@patkusch/kontext"><img src="https://img.shields.io/npm/v/@patkusch/kontext?style=flat-square&color=cb3837&label=npm" alt="npm"></a>
  <a href="https://github.com/patkusch/kontext/actions/workflows/ci.yml"><img src="https://github.com/patkusch/kontext/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/tests-34-brightgreen?style=flat-square" alt="34 tests">
  <img src="https://img.shields.io/badge/runtime%20deps-1-blue?style=flat-square" alt="One runtime dependency">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/licence-MIT-green?style=flat-square" alt="MIT"></a>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#for-ai-agents-mcp">For AI agents</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="docs/SPEC.md">The spec</a>
</p>

---

## The problem

Your project has a hundred markdown files. Some are load-bearing truth. Some describe a
system you refactored away eleven months ago.

**They look identical.** Same folder, same font, same confident tone.

You cope by ignoring the docs and reading the code. Your agent can't. Hand Claude a
stale runbook and it will follow the stale runbook, because it has no way to smell that
`src/auth/` was rewritten in March. So every team lands on one of two losing strategies:

- **Load everything** → burn the context window on documents that are mostly wrong
- **Load nothing** → rediscover the codebase from scratch, every single session

Neither is context *management*. They're surrender in two directions.

The root cause isn't volume. It's that **a markdown file is born and then immortal.**
Code has tests. Dependencies have versions. Infrastructure has health checks.
Documentation alone never has to prove it still works.

## The idea

> A context document isn't a file. It's **a claim about code** — and claims can be checked.

Let a document declare what it describes. Git already knows every change to that
subject, timestamped and attributed. So git can answer the question the document can't
answer about itself:

**Has the thing this document describes changed since the document last did?**

That has an objective answer. Two `git log` calls and a comparison. No LLM, no
embeddings, no vibes.

```yaml
---
kontext: 1
id: auth-session-flow
kind: guide
describes:
  - src/auth/**
  - src/middleware/session.ts
verify: npm run test:auth
---
```

That `describes` field is the whole trick. It turns an unfalsifiable assertion into a
checkable claim.

## Quickstart

```bash
npm install -g @patkusch/kontext
```

Or run it without installing anything:

```bash
npx @patkusch/kontext doctor
```

<details>
<summary>From source instead — no build dependencies beyond TypeScript</summary>

```bash
git clone https://github.com/patkusch/kontext.git && cd kontext && npm install && npm run build && npm link
```

</details>

Then, in any repo you want to look at:

```bash
kontext doctor
```

Works on any repo right now, with zero setup and zero frontmatter. It'll tell you how
bad things actually are.

```bash
kontext check
```

```
kontext check · 5 docs · ~42 tokens · ~/demo

── orphaned (1) ────────────────────────────────────────────────────────────────
 ⊘  docs/legacy-queue.md    7  1 dead glob
     · orphaned: `describes` glob workers/queue/** matches zero tracked files
       — the code this doc describes was deleted, renamed, or moved

── stale (2) ───────────────────────────────────────────────────────────────────
 ○  docs/auth.md     10  12 commits · 181d behind · 1 file
     · stale: 12 commits touched src/auth/** since this doc was last updated
       (latest: eeefbd7 'auth change 11', 19 days ago); the described code is
       181 days ahead of the doc (doc: 808f909 'initial: code and docs
       together', 200 days ago) — past the 45-day stale threshold
     · files that moved: src/auth/session.ts

── unverified (1) ──────────────────────────────────────────────────────────────
 ·  docs/philosophy.md   50
     · unverified: no `describes` field, so this doc makes no falsifiable
       claim about source files — staleness can be neither proven nor ruled
       out. Add `describes: [<globs>]` to make it checkable.

── fresh (1) ───────────────────────────────────────────────────────────────────
 ●  docs/api.md  100  1 file

1 fresh · 1 unverified · 2 stale · 1 orphaned
● fresh  ◐ drifting  ○ stale  ⊗ expired  ⊘ orphaned  ⇥ superseded  · unverified

check failed: 3 docs in fail set [stale, expired, orphaned]
```

*(Real output, not a mockup — that's `kontext check` run against a demo repo.)*

Every verdict cites its evidence. You can check the reasoning and overrule it — a tool
that says *"trust me, it's stale"* deserves the same fate as the docs it's judging.

### Adopt it gradually

```bash
kontext init --dry-run   # propose frontmatter for existing docs, write nothing
kontext init --yes       # prepend it, preserving every body byte-for-byte
```

`init` infers an `id` from the filename, guesses `kind` from structure, and proposes
`describes` globs from the code paths your doc actually mentions. **These are guesses,
and it marks them as guesses.** Narrow them by hand — that's the part that matters.

### Gate it in CI

```yaml
- run: kontext check --fail-on stale,orphaned   # needs fetch-depth: 0
```

That `fetch-depth: 0` matters: kontext proves staleness from git history, and a shallow
clone makes every doc look freshly committed.

Now a PR that changes `src/auth/` and not its docs fails the build. Documentation joins
the set of things that must keep working.

## How it works

```
  your docs ──┐
              ├──► scan ──► assess ──► rank ──► pack
  git history ┘             │                    │
                            │                    └──► budgeted bundle
                            └──► evidence:            for one task
                                 commits, dates,
                                 drift days
```

**Freshness verdicts:**

| | Verdict | Meaning |
|---|---|---|
| ● | `fresh` | Described code hasn't moved since the doc did |
| ◐ | `drifting` | Code moved, within the warning threshold |
| ○ | `stale` | Code moved materially after the doc — **don't trust it blind** |
| ⏱ | `expired` | Past its `expires` / `ttlDays` |
| ↪ | `superseded` | Another doc declares it replaced |
| ⊘ | `orphaned` | `describes` matches no files — the subject is gone |
| · | `unverified` | No `describes` — no claim to check |

`unverified` isn't a failure. Most docs in most repos start there. It marks *absence of
evidence*, and the honest thing to do with that is say so.

**Age is not staleness.** A 2019 ADR explaining why you rejected microservices is still
true — its subject is a historical decision, and history doesn't drift. A runbook from
last month with the wrong port is actively harmful. kontext ranks `decision` and
`runbook` docs differently for exactly this reason.

## Packing context for a task

```bash
kontext pack "refactor session expiry" --budget 8000
```

Ranks by **relevance weighted by freshness**, fills the token budget, truncates on
heading boundaries, stamps provenance on everything.

And the rule that matters most:

> **A pack never silently omits anything.**

Everything excluded gets reported — stale docs under `excludedForStaleness`, budget
casualties under `omitted`, each with a reason. An agent that doesn't know something was
withheld will reason confidently from a hole in its context and never signal doubt.
Silent truncation is indistinguishable, from the inside, from complete knowledge. That's
a worse failure than the stale docs this tool exists to fix, because it's invisible.

## Context switching & handoffs

The moment context reliably dies: you close the session. What you'd ruled out, what
surprised you, what you were mid-way through — all of it lived in a conversation that
just ended.

```bash
kontext handoff --task "session expiry refactor" \
  --message "ruled out Redis TTL; see open question on clock skew"
```

Captures branch, recent commits, working-tree changes, freshness of the docs touching
those files, open questions, next steps → `.kontext/handoff.md`, with `ttlDays: 7`
because working state rots faster than anything else you write.

**The acceptance test:** a fresh agent with no prior context can read it and resume the
work. If it needs the original conversation to make sense, it's a note, not a handoff.

## For AI agents (MCP)

This is where it stops being a linter and starts being infrastructure.

Instead of an agent slurping every markdown file, it gets a **freshness-aware context
API** — ranked, budgeted, and tagged with how much each source can be trusted.

```bash
claude mcp add kontext -- node /absolute/path/to/kontext/dist/mcp/server.js
```

<details>
<summary>Claude Desktop / other MCP clients</summary>

Claude Desktop's working directory isn't your repo, so `KONTEXT_ROOT` is required there:

```json
{
  "mcpServers": {
    "kontext": {
      "command": "node",
      "args": ["/absolute/path/to/kontext/dist/mcp/server.js"],
      "env": { "KONTEXT_ROOT": "/absolute/path/to/your/repo" }
    }
  }
}
```
</details>

**Tools exposed:**

| Tool | What it's for |
|---|---|
| `kontext_pack` | Ranked, budgeted context bundle for a task |
| `kontext_freshness` | "Can I trust this doc?" — verdict + evidence |
| `kontext_search` | Cheap discovery without pulling full bodies |
| `kontext_read` | A doc, **with its trust verdict attached** |
| `kontext_handoff_write` | Hand working state to the next agent |
| `kontext_handoff_read` | Pick up where the last one left off |
| `kontext_conflicts` | "Do my sources disagree?" |

`kontext_read` never returns a document without telling the agent whether it's
trustworthy. That's the entire thesis in one API decision.

## Conflict detection

Two docs, two different answers, and an agent picks one at random:

```bash
kontext doctor
```

```
⚠ contradiction  docs/setup.md ↔ README.md
  └ dev server port: "localhost:3000" vs "localhost:8080"
⚠ duplicate      docs/onboarding.md ↔ docs/getting-started.md
  └ 87% similar — one probably supersedes the other
```

Deliberately conservative. A false contradiction is worse than a missed one, because it
costs you trust in the tool.

## Design principles

1. **Evidence over opinion.** Every claim traces to a commit.
2. **Absence of evidence is reported as such.** `unverified` is a real answer.
3. **Never omit silently.** What got dropped, and why, is part of the output.
4. **Degrade, don't crash.** No frontmatter, no commits, broken YAML, globs matching
   nothing — all normal, none fatal.
5. **No lock-in.** Frontmatter is inert YAML. Delete kontext tomorrow and you've lost
   nothing but the tool.
6. **No LLM in the staleness path.** Determinism is the feature. Same commit, same
   answer, every time — which is the only reason CI can gate on it.

## What kontext deliberately doesn't do

- **Judge whether a doc is *good*** — only whether it's *current*. Different problems.
- **Auto-update your docs.** A tool that rewrites docs to match the code produces text
  describing the code, which the code already does better. The *why* is what
  documentation is for, and only you know it.
- **Use an LLM to detect staleness.** See principle 6.

## Commands

| | |
|---|---|
| `kontext doctor` | Diagnose the repo. Start here. |
| `kontext check` | Freshness verdicts + evidence. CI gate. |
| `kontext map` | Full corpus inventory and freshness heatmap. |
| `kontext pack <task>` | Budgeted context bundle. |
| `kontext init` | Propose frontmatter for existing docs. |
| `kontext handoff` | Capture working state for the next session. |
| `kontext mcp` | Run the MCP server (stdio). |

All commands support `--json`.

## Docs

- **[The Context Lifecycle Spec](docs/SPEC.md)** — the full model, the reasoning, and
  the open questions. Start here if you want to argue with the design.

## Status

Early. v0.1. The core mechanism — git-provable drift — is the part I'm confident in.
The ranking heuristics and conflict detection are where feedback would help most.

The [open questions](docs/SPEC.md#9-open-questions) are genuinely open: rename tracking
across refactors, monorepo scoping, section-level staleness, cross-repo context.

## License

MIT © [patkusch](https://github.com/patkusch)
