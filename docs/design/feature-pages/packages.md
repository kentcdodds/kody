# Packages feature page concept

## Position

Headline: **Keep the software your agent builds.**

Pitch: Save useful work as a package you own. Run it from a connected agent,
change it when your needs change, or give someone access to the same live
package.

Primary action: **Connect your agent** Secondary action: **Explore community
packages** → `/community`

Suggested title: `Reusable AI agent packages | Kody` Suggested description:
`Keep agent-built software in repos you own. Publish reusable packages, adapt community packages, and give people access to the work you want to share.`
Feature route: `/features/packages`.

## Evidence and boundaries

- `docs/guides/package-lifecycle.md`: repo rooted at package.json is the durable
  source of truth; callable exports, jobs, subscriptions, retrievers, and apps
  can belong to a package. Reuse existing behavior first, use execute for
  disposable exploration, fork a close public package before creating. Git
  authoring supports normal edits, local tests, commit, push, then publish.
- `docs/guides/package-authoring.md`: new packages are private; public HEAD is
  readable and forkable and appears in Community. Root README.md and AGENTS.md
  must be non-empty for an author-driven publish. README Intent describes why;
  export JSDoc describes callable purpose. Changes to HEAD are not automatically
  live, published_commit must move. Locked packages require owner promotion of
  the named commit.
- `docs/guides/package-sharing.md`: Use means read source and run; Contribute
  adds write; Manage adds publish, delete, and access management. A grant
  applies to one resource in its owning org. Outside collaborators cannot see
  unrelated org resources. Runs in the owner's org are billed there. A package
  cannot import across org boundaries even with a grant; fork public source into
  its own org first.
- `docs/guides/package-skills.md`: packages can contain validated Agent Skills.
  Serving them over MCP is off by default behind a flag, depends on the MCP lane
  and host extension support, and support is partial. Do not headline universal
  automatic skill syncing.
- `packages/worker/universal/landing-home-copy.ts`: existing Packages definition
  is “Durable software you own. An agent writes it once; any connected agent can
  run it.” Keep the continuity with the homepage's agent-neutral home.
- `packages/worker/client/routes/home.tsx`: existing art has Kody handing over a
  wrapped package at a parcel counter. Existing ecosystem copy says “Your own
  git and npm.” Expand this into a workbench, not another grid of benefits.

Do not imply packages run arbitrary native libraries or browsers in Kody's
Worker runtime. Heavy work can require an owner-operated process. Do not imply
publish checks establish correctness, remove the need for testing, or provide
automatic dry runs. Do not promise shared recipients cannot read code, Use
explicitly permits it. Do not conflate a fork with a live grant. Do not claim
public-source changes flow automatically into forks. These are reusable software
packages, not merely saved prompts.

## Search intent hypotheses

Unvalidated intent ideas, no volume or ranking claims:

- “reuse AI agent code” / “save AI agent automations”: lead with durable
  software and running it again.
- “share AI agent tools with team”: explain one live package and the three
  access presets.
- “AI agent package registry” / “MCP reusable tools”: show repository, exports,
  and community reuse.
- “AI agent skills package”: answer in a compact optional detail with the
  current host support limitation and a docs link.

The page should answer these with readable HTML, a descriptive title, and links
to the actual owning docs. No synthetic FAQ wall.

## Visual concept: the package workbench

An oversized blue package sits on a warm cream work surface. Its open lid
reveals three tangible layers: readable intent, source, and a published result.
A small koala at the edge carries the existing lantern, whose blue orb quietly
echoes the package accent. Use the supplied packages blue `oklch(0.6 0.2 255)`
for the package outline, selected state, and key action, with ink for long text
and pale blue washes for surface depth. Keep the homepage editorial type and
generous space.

This page's signature is an inspectable object that stays present while its
contents and ownership change. No full-page blue tint, no feature-card grid, no
terminal cosplay. A thin printed seam down the work surface becomes the source
history, then splits only when the visitor makes a copy. This makes the visual
explain durability, publication, and the fork/share distinction.

## Four purposeful beats

### 1. Open the thing you keep

H1 and pitch above. Hero object is a fictional **Weekly brief** package, visibly
marked **Example package**.

Three buttons along the open package lip: **Intent**, **Source**, **Result**.

Intent content: “Collect the project updates I choose and turn them into a
weekly brief.” Source content: a small realistic file tree with README.md,
AGENTS.md, package.json, src/brief.ts. Show source only after selecting Source,
do not make code a prerequisite for understanding the page. Result content: a
short example brief with named fictional project updates. No made-up speed or
success metrics.

The persistent label **Current published code** gives the next interaction a
concrete reference.

### 2. Change it. Keep what works.

Copy: “Your package has a repo. Your agent can update the source, check it, and
publish the next version.”

Meaningful demo: **Include open questions** toggles a visible proposed edit in
the example brief. The result still shows the current published code until
**Preview proposed change** is pressed. A split sheet then shows the new draft
and the current published output. **Publish example version** makes the proposed
change current, with a concise confirmation “Example change is now published.”
Every action is an in-page simulation with no external calls.

The point is not a pretend AI chat. The visitor learns that source edits and
live behavior are different states, and publishing changes what runs. Do not
render the check as a security guarantee. Label the fixture check precisely, for
example “Example output includes open questions.”

Supporting link: **How packages are built** → `/docs/package-authoring`

### 3. Share the work, or hand over a copy.

Copy: “Give someone access to your live package. Fork a public package when they
should own their own version.”

Two real buttons, **Share access** and **Make a copy**, transform the same
workbench object.

Share access: one package remains on the seam, two people connect to it. A
select named **Access level** reveals exact consequences: **Use: read and run**,
**Contribute: read, run, and edit**, **Manage: edit, publish, delete, and manage
access**. Show “Runs stay in the owner's organization.” Link details for billing
and org context rather than adding a sales caveat wall.

Make a copy: the seam branches into two separate package objects, each with its
own owner label. Copy: “Adapt a public package in your own organization. Changes
to your copy are yours.” A later example edit changes only the copy, making the
distinction visible.

Link: **Package sharing and access** → `/docs/package-sharing` Link: **Find a
package to adapt** → `/community`

### 4. Start with work you already repeat.

A compact, full-width use-case chooser changes a single starter intent sheet,
not three separate cards.

**For yourself**: “Turn your recurring project brief into software you can run
again.” **For your team**: “Keep one reporting package current, and give
teammates access to run it.” **Across your organization**: “Choose who can run,
edit, and publish a shared package.”

These are possible uses supported by package durability and grants, not claims
about bundled templates or enterprise certifications. Do not invent SSO,
compliance, customer names, or audit features.

Closing action: **Connect your agent** using the existing homepage action
destination. Secondary: **Read the package guide** → `/docs/package-lifecycle`.

## Connections to the other pages

Use inline links when the relevant concept appears, not a sixth feature-card
grid. Package-owned schedules lead to the Triggers feature page, connected
account access to Integrations, credentials to Secrets, and hosted package pages
to Apps. Feature routes are `/features/triggers`, `/features/integrations`,
`/features/secrets`, and `/features/apps`. Proven docs destinations include
`/docs/package-lifecycle`, `/docs/package-authoring`, `/docs/package-sharing`,
`/docs/package-skills`, and `/community`.

Optional inline detail beside Source: “Packages can also include Agent Skills.”
Link `/docs/package-skills`; if showing MCP delivery, include “Host support
varies. Skills over MCP is currently opt-in.” Avoid borrowing unsupported broad
skill portability copy from the homepage.

## Accessibility and motion

Use native buttons and a select for every state. Keep the reading order
headline, package identity, controls, active content, status. Do not require
dragging, hovering, precise pointer paths, or scrolling to operate the demo.
Give the result region a polite live announcement only after an action.
Distinguish a draft from published source in words, not blue alone. Decorative
koala, seams, and lantern are aria-hidden.

On small screens, the workbench becomes a vertical sequence with the same
controls, no horizontal canvas. Reduced motion uses immediate state changes; the
normal transition is a short lid reveal or connector redraw, never endless
rotation, floating text, or automatic demo advancement. No-JS shows the intent,
example source, result, and fork-versus-share explanation in ordinary document
flow.

## Editorial review

Keep publication visible without inventing product-level version numbers,
release selectors, or runnable old versions. See
`docs/contributing/decisions/0001-no-package-versioning.md` and
`0031-kody-dependencies-wildcard-map.md`. Git history and the current published
commit are the model.
