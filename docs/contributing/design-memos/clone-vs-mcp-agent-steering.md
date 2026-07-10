# Design memo: steering coding agents toward clone-edit-push

**Status:** Draft — awaiting Kent approval before implementation. No product
behavior changes in this PR; this file is the entire change.

## Problem

Coding-capable agents (Cursor, Claude Code) doing package authoring work default
to the MCP loop — `search` → `execute` → `package_save` with inline file blobs —
instead of the faster, more natural local workflow: `package_get_git_remote` →
clone to a temp dir → normal edits (including binary assets) → push →
`package_publish_external_push`. A real session creating a community
`@kentcdodds/notion` package spent its time in MCP research
(`integration_bootstrap`, `community_publish`, the `package_authoring` guide)
and only reached for clone after the user asked "are you doing that?"; a
subagent then finished quickly via clone-edit-push.

## Why coding agents skew MCP-only

These are findings from the repo, not hypotheses. Ordered by weight:

1. **The git lane cannot start at creation time.** `package_get_git_remote`
   resolves an existing saved package and throws
   `Saved package "<id>" was not found.` otherwise
   (`packages/worker/src/mcp/capabilities/packages/resolve-package-source.ts`).
   For "create a new package" — the most common authoring entry point —
   `package_save` is mandatory. Every prescriptive "prefer
   package_get_git_remote" sentence is fighting the shortest legal path. Once an
   agent has produced the full file set inline for the first save, sunk cost
   keeps it in the MCP loop for every subsequent edit.

2. **The server instructions never mention the git lane.**
   `packages/worker/src/mcp/server-instructions.ts` opens with the "Two-step
   flow" (`search` then `execute`), lists `package_save` as a core convention
   bullet, and does not contain the string `package_get_git_remote` anywhere.
   The only steering toward clone lives in places an agent sees late or never:
   inside `package_save`'s own description ("Prefer package_get_git_remote or
   repo sessions for iterative edits" — read only after search already ranked
   `package_save` as the answer), and in the `packages` domain one-liner.

3. **Search ranking rewards the wrong capability for authoring queries.**
   `package_save` carries keywords `create`, `update`, `package`
   (`save-package.ts`); `package_get_git_remote` carries `git`, `clone`, `push`,
   `local clone` — nothing an agent types when its intent is "create a new
   package." Lexical scoring is token-intersection over the query
   (`capability-search.ts`), so "create new package" hits `package_save` twice
   and the git capability once, before vector fusion. The task lexicon in
   `understand-search-query.ts` classifies `create` as `operate`, which
   penalizes capabilities slightly in favor of saved packages — but for a _new_
   package no saved package exists, so `package_save` still tops the list.

4. **The prescribed pre-reading reinforces the loop.** Instructions require
   `coding_guide_get` with `package_authoring` before creating a package, and
   `integration_bootstrap` before integration-dependent work. Both guides are
   silent on clone-edit-push (`docs/guides/package-authoring.md` covers README
   Intent and `private` only). The observed "research spiral" is an agent
   following instructions perfectly — and never once encountering git. The clone
   instructions in `docs/use/packages.md` are not reachable through
   `coding_guide_get` at all.

5. **Kody cannot tell who it is talking to.** `McpCallerContext`
   (`packages/shared/src/chat.ts`) carries no client identity or environment
   signal, even though the MCP initialize handshake delivers `clientInfo`
   (name/version) to the server. All callers — a phone chat app and a Cursor
   agent with a full shell — receive identical instructions, identical search
   ranking, and identical capability descriptions hedged with "coding agents
   with local filesystem/git access should…". The agent must self-classify from
   a subordinate clause.

6. **The cost asymmetry is invisible until it hurts.** `package_save` looks like
   one round trip; clone looks like three capabilities plus shell work. Nothing
   surfaces the real asymmetry — inline blobs are UTF-8-text-only
   (`packageFileSchema`), so binary assets are impossible; full-fileset
   replacement risks the destructive-overwrite policy; large packages round-trip
   megabytes per edit. Agents optimize perceived tool-call count.

## Proposed steering mechanisms

### A. Git-native creation: make clone the shortest path (structural)

Add a creation-capable git entry point — either a new `package_create`
capability or a `create: true` + `kody_id` mode on `package_get_git_remote` —
that registers a stub saved package server-side (empty repo or minimal
`package.json` scaffold) and returns the minted remote, bearer header, and
`setup_commands` in **one call**. Give it the keywords `create`, `new`,
`scaffold`, `package` so it competes head-to-head with `package_save` on the
exact queries that currently funnel agents into blobs. Publishing stays
`package_publish_external_push`, which already runs the server-side checks.

The point: today "prefer git" is a plea against incentives. After this, the git
lane is one tool call to start and one to finish, and the search hit for "create
new package" can honestly describe the workflow the agent should use.

### B. Steer in the tool response, not the instructions (behavioral)

`docs/contributing/documentation.md` already states the principle: "Put
post-call detail in the call result." Apply it to steering. When `package_save`
succeeds — especially on create, or when the payload crosses a size/file-count
threshold — the success payload includes a `next_steps` block with the _actual_
ready-to-paste `setup_commands` for that package (the same strings
`package_get_git_remote` mints), not a suggestion to go call another capability.
Escalate on repetition: a second consecutive full-fileset `package_save` in the
same `conversationId` (state the MCP Durable Object already tracks) gets a
firmer "you are round-tripping the full file set; coding agents should clone"
preamble. Agents weight instructions embedded in tool results far more than
static server instructions they read once at session start.

### C. Environment handshake: vary the defaults by caller (contextual)

Capture `clientInfo` from the MCP initialize handshake into `McpCallerContext`,
and let a small allowlist (cursor, claude-code, cline, windsurf, …) or an
explicit self-declaration field flip a `callerEnvironment: coding | tool-only`
bit. Coding callers get: a server-instructions variant whose package-authoring
bullet leads with clone-edit-push, a rerank boost for `package_get_git_remote` /
`package_publish_external_push` in `rerankCandidates`, and `repo_run_commands`
demoted. Tool-only callers keep today's text. This turns every existing "if you
are a coding agent…" hedge into a default instead of a subordinate clause.
`clientInfo` is advisory (a coding client may still be run without shell
access), so it adjusts ranking and emphasis, never hard-gates a capability.

### D. Workflow cards as first-class search results (discovery)

Unified search already returns five entity types and per-capability "exact
execute snippet" details. Add a sixth: a small static set of **workflow**
results — "Author a package (coding agent lane / tool-only lane)", "Publish to
community" — that match authoring-intent queries via a new `author` task lexicon
entry (`create`, `build`, `publish`, `scaffold`, `package`) in
`understand-search-query.ts`. A workflow card ranks above individual
capabilities for those queries and lays out both lanes with exact call
sequences, so the agent's first search result frames the _choice_ rather than
pre-committing it to `package_save`. Cheap sibling: add a `package_authoring`
guide section (or a new `coding_guide_get` id) that finally carries the
clone-edit-push content from `docs/use/packages.md`.

### E. Complexity triage with a handoff prompt (self-selection)

The other approaches steer a coding-capable agent toward the right lane. This
one steers a **tool-only** agent out of work it should not attempt. Before
starting package authoring, the agent estimates whether the request is feasible
through MCP round trips alone. When any hard trigger fires, it stops, tells the
user this task fits a coding-capable agent better, and asks for confirmation
before grinding through the MCP lane.

The triggers are objective, not vibes — each maps to a real constraint in this
repo:

- **Binary assets** — `packageFileSchema` is UTF-8-text-only; images, fonts, or
  archives cannot pass through `package_save` or `repo_write_file` at all.
- **Large or many-file changes** — repo session capability bundles cap at 250
  files / 2 MiB, publish checks at 2,000 files / 15 MiB; multi-file refactors
  through `git apply` heredocs hit unified-diff context drift, the failure mode
  `repo-run-commands-text.ts` already warns about.
- **Iterative build/test loops** — repo sessions accept only parsed git command
  forms; there is no `npm`, no shell, no way to run a test suite between edits.
- **Vendored dependencies or generated output** — anything normally produced by
  a local toolchain has no MCP-side equivalent.

Steering lives in two places. First, a short triage bullet in the server
instructions and the `repo_run_commands` description (its description already
self-identifies the tool-only audience, so it is the natural anchor). Second —
the novel part — a **handoff prompt** in the confirmation: the repo already has
the copyable-prompt pattern in `buildForkPrompt` (`community-public.ts`), which
packages a task into a paste-into-an-agent instruction. The same pattern here
produces a ready-to-paste prompt for the user's coding agent: package name or
kody id, the user's goal, and the clone-edit-push call sequence
(`package_get_git_remote` → clone → edit → push →
`package_publish_external_push`). The tool-only agent's failure mode becomes a
one-paste onboarding for the right agent, instead of a dead end or a long
degraded session.

A response-side backstop mirrors approach B: repo session responses already
return line-specific parse errors, so after repeated `git apply` failures or
many round trips in one `conversationId`, the response can carry the same
handoff recommendation — catching agents that misjudged the triage upfront.

## Comparison

| Approach                 | Fixes                                       | Cost / risk                                                         |
| ------------------------ | ------------------------------------------- | ------------------------------------------------------------------- |
| A. Git-native creation   | The structural funnel (root cause #1, 3)    | New capability + stub-source lifecycle; must handle abandoned stubs |
| B. Response steering     | Momentum / sunk cost (#2, 6)                | Small; response bloat if overdone; needs per-conversation counters  |
| C. Environment handshake | One-size-fits-all defaults (#5)             | `clientInfo` plumbing + instruction variants; allowlist maintenance |
| D. Workflow cards        | First-search framing (#3, 4)                | New search entity type; static content to garden                    |
| E. Complexity triage     | Tool-only agents attempting infeasible work | Instruction text + handoff prompt; triage thresholds need tuning    |

**Recommendation: A + B, with E's triage text as a cheap rider.** A removes the
only _structural_ reason the MCP loop wins — everything else is copywriting
until the git lane can actually start at creation. B is the cheapest
high-leverage complement and is already endorsed by this repo's own
documentation principles; it catches agents that entered via `package_save`
anyway and hands them the exit ramp with zero extra discovery cost. E addresses
a different failure — the tool-only agent that should not be doing the work at
all — and its instruction-text half costs almost nothing to ship alongside A/B;
the handoff-prompt half can follow once the triage triggers prove out. C is the
most interesting long-term (it generalizes beyond packages to
`repo_run_commands` routing) but is advisory-signal plumbing that can land after
A/B prove the direction. D overlaps heavily with fixing guide content, which
should happen regardless.

## Non-goals

- No change to publish safety checks, backup-snapshot policy, or the tool-only
  `repo_run_commands` lane — tool-only agents remain fully served.
- No hard gating on client identity; steering is default-shaping only.
- Nothing in this memo is implemented; it exists for review.

---

_Awaiting Kent approval before implementation._
