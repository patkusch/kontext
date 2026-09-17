---
kontext: 1
id: context-lifecycle-spec
kind: spec
describes:
  - src/types.ts
owner: patkusch
tags: [spec, context, lifecycle]
pin: true
---

# The Context Lifecycle Spec

**Version 1 · status: draft · implemented by [kontext](https://github.com/patkusch/kontext)**

> This document practises what it specifies. Its frontmatter declares that it
> describes `src/types.ts` — so if the contract changes and this spec doesn't,
> `kontext check` fails kontext's own CI. A spec that can go quietly stale is
> exactly the problem this spec exists to describe.

---

## 0. The problem this exists to solve

A project accumulates markdown. Fifty files, then two hundred, then more. Some of it
is load-bearing truth. Some of it described a system that was refactored away eleven
months ago. Both look identical: same font, same folder, same confident tone.

Everything downstream breaks on this one fact:

> **You cannot tell a fresh document from a rotting one by looking at it.**

Humans cope by ignoring the docs and reading the code. That is a defeat, but a
survivable one — a human notices when a doc contradicts reality and silently discards it.

An AI agent has no such immune system. Handed a stale runbook, it will follow the stale
runbook. It cannot smell that the auth module was rewritten. So teams land on two bad
strategies:

1. **Load everything.** Burn the context window on documents that are mostly wrong.
   Signal drowns. The agent confidently cites a file that no longer exists.
2. **Load nothing.** Rediscover the codebase from scratch every session. The agent
   re-asks questions answered in a document sitting three directories away.

Neither is a context *management* strategy. They are surrender in two directions.

The root cause is not volume. It is that **a markdown file has no lifecycle.** It is
born, and then it is immortal. Nothing marks it as provisional, nothing retires it,
nothing notices when the world it describes moves on. Every other artifact in a
software project has a lifecycle — code has tests, dependencies have versions,
infrastructure has health checks. Documentation alone is exempt from having to prove
it still works.

This spec ends that exemption.

---

## 1. The core idea

> **A context document is not a file. It is a claim about code, and claims can be
> checked.**

If a document declares *what it describes*, then version control — which already
records every change to that subject, timestamped and attributed — can answer the
question the document cannot answer about itself:

**Has the thing this document describes changed since the document last did?**

That question has an objective answer. It requires no language model, no embeddings,
no heuristics, and no judgement call. It is two `git log` invocations and a comparison.

This is the entire foundation. Everything else in the spec is built on it.

### Why this framing is the useful one

Other approaches to "stale docs" fail in instructive ways:

| Approach | Why it fails |
|---|---|
| Last-modified date | Measures typo fixes and reformatting as if they were review. A doc touched yesterday can describe a system from 2023. |
| Manual review dates | Decays instantly. Nobody updates a `last-reviewed:` field, and nothing forces them to. |
| Asking an LLM "is this stale?" | Non-deterministic, expensive, unfalsifiable, and it must read the whole corpus to guess. Produces opinions, not evidence. |
| Doc coverage metrics | Measures how *much* documentation exists, which is the opposite of the problem. |

Git drift measures the right thing — **divergence between a claim and its subject** —
and produces evidence a human can audit: specific commits, specific files, specific
dates. A verdict you can argue with is worth more than a score you must trust.

---

## 2. The frontmatter contract

A kontext-aware document carries a YAML block at the top of the file:

```yaml
---
kontext: 1
id: auth-session-flow
kind: guide
describes:
  - src/auth/**
  - src/middleware/session.ts
verify: npm run test:auth
owner: patkusch
ttlDays: 90
tags: [auth, security]
---
```

### Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `kontext` | integer | ✅ | Spec version this document was written against. |
| `id` | slug | ✅ | Stable identifier, unique in the repo. Survives file renames. |
| `kind` | enum | | Role of the doc. Drives pack ranking. See §3. |
| `describes` | glob[] | | **The load-bearing field.** Source files this doc makes claims about. |
| `verify` | string | | Shell command that proves the doc is still true. |
| `owner` | string | | Who to ask when it goes stale. |
| `expires` | ISO date | | Hard expiry. |
| `ttlDays` | integer | | Expiry relative to the doc's last commit. |
| `supersedes` | id[] | | Documents this one replaces. They become `superseded`. |
| `tags` | string[] | | Retrieval hints. |
| `pin` | boolean | | Always include in packs, regardless of relevance. |

### On `describes` — the only field that really matters

Every other field is convenience. `describes` is the one that converts a document from
an unfalsifiable assertion into a checkable claim. A doc without it can never be
proven stale — and, importantly, can never be proven fresh either. kontext marks such
docs `unverified`, which is a description of the doc's epistemic status, not an insult.

**Write `describes` as narrowly as you honestly can.** `src/**` technically covers
everything and therefore tells you nothing: every commit drifts it, so it screams
constantly and gets ignored. A glob that matches the twelve files a doc actually
discusses produces a signal worth acting on. The discipline of narrowing the glob is
itself valuable — it forces you to say what a document is *about*, which is a question
surprisingly many documents cannot survive.

### On `verify` — the stronger claim

Drift proves a doc *might* be wrong. `verify` proves a doc is *right*, by running
something that fails when the doc's claims stop holding:

```yaml
verify: curl -sf localhost:3000/health     # the port in this runbook is real
verify: npm run test:auth                  # the flow described still passes
verify: test -f src/auth/session.ts        # the file this doc explains still exists
```

This is documentation-as-a-test. Not every doc can support it. The ones that can
become the most trustworthy documents in the repository — and the gap between what
can and cannot be verified tells you something honest about your own docs.

---

## 3. Document kinds

Kind determines how a document is ranked when context is assembled for a task,
because not all documents are equally useful under a token budget.

| Kind | Contains | Rots |
|---|---|---|
| `decision` | Why we chose X over Y | Slowly — the reasoning stays valid even after the code moves |
| `runbook` | Steps to perform an operation | Fast — commands, ports and paths drift constantly |
| `guide` | How something works | Medium |
| `reference` | Schemas, APIs, surfaces | Fast, but mechanically checkable |
| `spec` | A contract others implement | Slowly — a spec is *supposed* to outlive its implementations |
| `handoff` | State passed between sessions | Immediately — days, not months |
| `index` | A map of other docs | Whenever the corpus changes |

The distinction that matters most is **`decision` vs `runbook`**. An architectural
decision record from 2019 explaining why you rejected microservices is *still true* —
its subject is a historical choice, and history does not drift. A runbook from last
month with the wrong port is *actively harmful*. Age is not staleness. Treating a
five-year-old ADR and a five-week-old runbook by the same date-based rule is how
freshness heuristics lose credibility.

---

## 4. Freshness verdicts

Every document resolves to exactly one verdict. Where several apply, the most severe wins.

| Verdict | Meaning | What to do |
|---|---|---|
| `fresh` | Described code has not moved since the doc did | Trust it |
| `drifting` | Code moved, within the warning threshold | Review soon |
| `stale` | Code moved materially after the doc | **Do not trust without checking** |
| `expired` | Past `expires` / `ttlDays` | Re-confirm or delete |
| `superseded` | Another doc declares it replaced | Read the successor |
| `orphaned` | `describes` matches no files | The subject is gone; the doc probably should be too |
| `unverified` | No `describes` — no claim to check | Unknown. Add `describes` to find out |

`unverified` is deliberately not a failure state. Most documents in most repositories
start here. It marks *absence of evidence*, and the honest thing to do with absence of
evidence is report it as such rather than assume the best or the worst.

### Scoring

Alongside the verdict, each doc carries a `0–100` score that degrades **continuously**,
not in cliffs. A doc 44 days behind and a doc 15 days behind are both `drifting`, but
they are not equally trustworthy, and ranking must be able to tell them apart.

### Evidence is mandatory

**A verdict without evidence is a rumour.** Every non-fresh verdict must cite what
produced it:

```
○ stale   docs/auth.md
  └ 12 commits touched src/auth/** since this doc was last updated
    (latest: a3f9c21 "rework session refresh", 31 days ago)
```

A reader must be able to check the reasoning and overrule it. A tool that says "trust
me, it's stale" earns the same fate as the docs it is judging.

---

## 5. Context packs

Freshness is the input. The output is **assembly**: given a task and a token budget,
produce the best bundle of context that fits.

```
kontext pack "refactor session expiry" --budget 8000
```

A pack ranks by **relevance weighted by freshness**, includes pinned docs, fills the
budget greedily, truncates the final entry on a heading boundary rather than dropping
it, and stamps provenance on everything.

### The non-negotiable rule

> **A pack must never silently omit anything.**

Every excluded document is reported — the stale ones under `excludedForStaleness`, the
budget casualties under `omitted`, each with a reason. An agent that does not know
something was withheld will confidently reason from a hole in its context and never
signal doubt. Silent truncation is indistinguishable, from the inside, from complete
knowledge. That failure mode is worse than the stale docs this spec set out to fix,
because it is invisible.

---

## 6. Handoffs

Context switching — between sessions, between agents, between a human and an agent —
is where context dies most reliably. The working state (what I was doing, what I had
ruled out, what surprised me) exists only in a conversation that is about to end.

A `handoff` document captures it: branch, recent commits, working-tree changes, the
task, the freshness of docs relevant to the changed files, open questions, next steps.

Handoffs carry `ttlDays: 7` by default because working state rots faster than anything
else in the corpus. A week-old handoff describing a branch that has since been merged
is actively misleading.

**Acceptance test for a handoff:** a fresh agent with no prior context can read it and
resume the work. If it needs the original conversation to make sense, it is a note, not
a handoff.

---

## 7. Design principles

1. **Evidence over opinion.** Every claim traces to a commit. No unfalsifiable scores.
2. **Absence of evidence is reported as such.** `unverified` is a real answer.
3. **Never omit silently.** What was dropped, and why, is part of the output.
4. **Degrade, don't crash.** Run over messy real-world repos: no frontmatter, no
   commits, broken YAML, globs matching nothing. All normal. None fatal.
5. **No lock-in.** Frontmatter is inert YAML. Every doc stays a plain markdown file
   that renders fine on GitHub with or without this tool. Adoption must be reversible —
   delete the tool and you have lost nothing.
6. **The narrow glob is the discipline.** The tool's value is proportional to how
   honestly `describes` is written. It cannot supply that honesty, only reward it.

---

## 8. What this spec deliberately does not do

- **It does not judge whether a document is *good*.** Only whether it is *current*.
  Those are different problems and conflating them makes both harder.
- **It does not use an LLM to assess staleness.** Determinism is the feature. Two runs
  on the same commit give the same answer, and CI can gate on it.
- **It does not auto-update documents.** A tool that rewrites your docs to match the
  code produces text that describes the code — which the code already does, better.
  The *why* is what documentation is for, and only a human knows it.
- **It does not require adoption to be useful.** `kontext doctor` and `kontext map`
  work on a repo with zero frontmatter, which is exactly the repo that needs them most.

---

## 9. Open questions

Genuinely unresolved, and feedback is welcome:

- **Rename tracking.** Resolved for per-file history: `git log --follow` is deliberately
  not wired into `src/core/git.ts`, on measured evidence rather than a guess (see
  `test/git-rename.test.js` and the comment on `lastCommitForPath`). It hard-requires a
  single pathspec, but every evidence function here takes a path *list* because a
  `describes` glob routinely resolves to more than one file — that's the common case,
  not an edge case — so `--follow` could only ever help the minority of docs with a
  single-file `describes`, and even then its output mixes old and new filenames in a way
  that would leak a since-renamed path into evidence documented as "currently tracked
  files." Still open: glob-level rename detection across a refactor, which is a different
  problem (relocating a doc's *subject*, not counting a file's commits) — a doc whose
  subject moved from `src/auth/` to `src/identity/` currently reads as `orphaned`, which
  is technically true and practically annoying. The likeliest fix there is `-M`
  similarity on a normal, non-`--follow` `git log` across the whole repo (which doesn't
  share `--follow`'s single-path limit), used to propose an updated `describes` glob —
  not yet built.
- **Monorepos.** Should drift be scoped per-package? A commit in `packages/ui` probably
  should not drift a doc describing `packages/api`, but the glob already expresses that.
  Unclear whether anything more is needed.
- **Partial staleness.** Right now a document is stale as a whole. Section-level
  `describes` would be more precise and considerably more annoying to write.
- **Cross-repo context.** Organisational knowledge spans repositories. Git drift assumes
  one history. The obvious extension is a federated index; the obvious cost is that it
  stops being a zero-config tool.

---

*Part of [kontext](https://github.com/patkusch/kontext) — MIT licensed.*
