# Memory feature page brief

## Core direction

**Headline:** New agent. Same you.

**Pitch:** Save the facts and preferences you keep repeating. Kody makes them
available to every agent connected to your account.

**Primary action:** Connect your agent

**Secondary action:** Try the handoff

The page is a warm coral memory desk. One durable note stays put while the
surrounding conversations change. The central product truth is continuity across
agents, expressed as a small, personal moment rather than an abstract data
network. Use `oklch(0.63 0.22 29)` for the memory accent, pale coral paper, deep
warm ink, generous cream space, and the site's existing editorial typography.
Reuse the memory orb artwork sparingly as the seal on the note. The koala can
hold the corner of the note in one static illustration, no mascot speech or
decorative labels.

## Grounded facts and claim boundaries

- `docs/guides/memory.md`: a memory is a durable fact or preference on one Kody
  account. Other agents connected to that same account can use it. Categories
  can include preferences, profiles, identifiers, relationships, workflows, and
  projects, but are freeform.
- `docs/use/memory.md`: search can surface relevant memories from its query.
  Execute retrieves when the agent supplies `memoryContext`. Automatic retrieval
  returns a compact top one or two relevant active memories. This is task-based
  retrieval, not every fact injected into every chat turn.
- `packages/worker/src/mcp/tools/memory-tool-context.ts`: implementation owns
  retrieval query construction, duplicate collapsing, compact subject/summary
  formatting, and structured surfaced-memory output. This supports visualizing a
  short relevant note instead of a whole conversation archive.
- `docs/guides/memory.md` and `docs/use/memory.md`: agents verify related
  existing memories before a write, then decide whether to create, update,
  delete, or do nothing. The agent should tell the person what it saved. Do not
  claim Kody independently understands contradictions or automatically fixes
  stale memories.
- `docs/guides/memory.md`: memories can reference canonical source URLs. They
  can be searched, read, updated, and deleted. Deletion is soft by default, with
  permanent deletion available. `/account/memories` offers JSON download, with
  deleted records included only when selected.
- `packages/worker/universal/memory-export.ts`: account memory downloads use a
  dated JSON filename. Do not turn this into a migration/import claim.
- `docs/guides/connect-your-agent.md`: MCP is the connection mechanism. The
  person keeps using their existing agent. Connecting an agent gives it full
  access to that Kody account. Never depict per-agent memory access controls.
- `docs/guides/first-win.md`: the optional email introduction flow can produce
  explicitly saved memories. Kody does not run its own autonomous chat-agent
  loop. Avoid depicting ambient listening, passive recording of every chat, or
  automatic preference extraction with no agent action.
- `packages/worker/universal/landing-home-copy.ts`: homepage promises continuity
  across hosts and uses “Your agents’ cloud.” Preserve its locked homepage copy.
  This new page can deepen the memory story without replacing those strings.
- `packages/worker/universal/landing-lantern.ts` and
  `packages/worker/client/routes/landing-primitives.tsx`: memory already belongs
  to the lantern primitive system, with
  `/images/lantern/kody-primitives-orb-memory.webp` as existing art.

Do not promise full chat-history sync, unlimited recall, perfect retrieval,
autonomous memory capture, a shared company knowledge base, organization-wide
memory, team permissions, compliance certifications, enterprise administration,
or saved credentials in memory. “Shared” means agents connected to the same
person's account, not separate users.

## Search-intent hypothesis

Likely needs include “share memory between AI assistants,” “AI memory across
agents,” “MCP persistent memory,” and “stop repeating context to AI.” These are
language hypotheses from the product problem, not researched search-volume
claims. Use a descriptive title such as “Shared memory for your AI agents |
Kody” and a readable lead that includes “facts and preferences.” Keep
implementation terms in the supporting explanation or docs link rather than
forcing them into the headline.

## Four page beats

### 1. The handoff, above the fold

Headline and pitch sit at upper left. A large paper note slightly overlaps the
conversation demo below rather than sitting inside a generic hero illustration
card. It reads:

> Writing preference Lead with the decision. Keep updates short. Saved in Kody

Beside it, the first example conversation says:

> Remember this for project updates: lead with the decision and keep it short.

Agent confirmation:

> Saved your project-update preference in Kody.

The main demo control says **Switch to another agent**. Selecting it changes a
clearly labeled sample conversation from “Agent 1” to “Agent 2” while the note
stays anchored. The next prompt says:

> Help me write a project update.

A compact retrieval strip reads **Relevant memory: Lead with the decision. Keep
updates short.** The sample draft beneath starts with the decision and has two
short sentences. Keep a small “Example” identifier attached to the demo so
nobody mistakes it for a connected live account. Avoid fabricated vendor UI;
optional host names can be text controls using existing verified brand
treatments.

This interaction demonstrates one retrieved preference. It does not imply
complete conversation transfer or guaranteed results from all prompts. On mobile
the memory note precedes the conversation in document order, with a simple agent
switch underneath.

### 2. Remember the thing that matters now

**Heading:** A little context goes a long way.

**Copy:** A writing preference. A project name. The person you mean when you say
“my accountant.” Keep the details worth carrying into the next conversation.

A broad, shallow index of three selectable notes uses uneven paper lengths and
ordinary text, not three feature cards. Select **Writing**, **Projects**, or
**People** to pair one stored fact with a plausible task. The selected note is
sharply rendered; the others stay visible and quiet. This demonstrates relevance
without showing a fake ranking score or more than two retrieved items.

Example pairs:

- Writing: “Lead with the decision.” Task: “Draft my weekly update.”
- Projects: “The website refresh is called Orchard.” Task: “Help me outline an
  Orchard update.”
- People: “Morgan is my accountant.” Task: “Draft a question for my accountant.”

All outputs are drafts. No email gets sent, no project system is queried, and no
integration is implied. One optional expandable sentence explains: “Kody returns
a small amount of relevant context when your connected agent searches or runs
work with a memory hint.” Link the technical details to the memory docs.

### 3. The preference changes

**Heading:** Changed your mind? Change the memory.

**Copy:** Ask your agent to update what it remembers. It checks related memories
first, then tells you what changed.

Return to the exact note from the hero. A button, **Make updates more
detailed**, reveals the sample request “For project updates, include the
decision, the reason, and the next step.” A small three-line transcript shows
“Found your existing writing preference,” “Updated the saved preference,” and
the new note. Use a visible text replacement with a short crossfade, no confetti
or speed metric. A reset button restores the original example.

Under the note, one practical line: “Search your memories, remove what you no
longer need, or download a JSON copy.” Link **Download your memories** to
`/account/memories`, identifying sign-in if the shared account-link pattern
requires it. Do not imply a visual edit interface until verified, the update
story is through the connected agent.

### 4. Take it to your next agent

**Heading:** Introduce yourself once more. Then try a second agent.

**Copy:** Connect Kody, save one useful preference, and ask another connected
agent to use it.

**Action:** Connect your agent

Include a copyable starter prompt:

> Save this in Kody memory: for project updates, lead with the decision and keep
> it short.

Then a separate second-agent prompt:

> Look up my project-update preference in Kody and help me draft an update.

This is an honest, achievable proof, with an explicit lookup in the second
prompt. Link to the connection guide for setup. Keep the last composition
compact, with a coral rule extending from the saved note to the action. No
generic testimonial, pricing, or metrics section.

## Personal, business, and enterprise relevance

Express these as recognizable examples inside beat two, not invented product
tiers or three audience panels. Personal: a travel or writing preference.
Business: a project alias and preferred client-update format. A person working
inside a larger company: their role, a known project name, and an optional
source link for context. State that memories belong to the account. Do not
describe company-wide sharing, central policy enforcement, or permissions that
do not exist. A source URL is a pointer, not evidence that Kody has indexed or
can access the entire document.

## Neighboring paths

- Memory guide: resolve `docs/guides/memory.md` through the existing
  `docHref('memory')` convention, expected public `/docs/memory`.
- Connection guide: resolve `docs/guides/connect-your-agent.md` through its
  registered docs slug; primary product setup action is `/onboarding`.
- Account download: `/account/memories`.
- Secrets: contextual line if necessary, “Credentials belong in secrets.” Link
  to `/features/secrets` or `/docs/secrets`.
- Packages: the remembered project-update preference can inform work an agent
  does with a reusable package. Link with “Make recurring work reusable” rather
  than implying memory itself executes work. Link to `/features/packages`.
- Integrations: optional small link from connected-agent setup only when it
  explains a distinction. Connecting an AI agent and connecting an external
  service are different steps, avoid conflating them.

## Accessibility and rendered-copy audit

Use real buttons with visible focus and pressed/selected state, not
draggable-only paper or hover-only facts. All demo text must remain selectable
and readable. Announce the changed sample outcome once with a polite live
region; do not announce decoration. Keep the coral accent for decoration and
strong states, verify contrast before using it for small text. Labels and
placement must distinguish saved memory, example conversation, and selected
agent without relying on color. Reduced motion replaces every transfer/crossfade
with an immediate state change. No scroll locking, autoplay carousel, floating
continuous movement, or required animation completion. The no-JavaScript version
presents the saved note and second-agent example together, with the starter
prompts and onboarding link intact. On rendered review, remove any label that
merely describes already obvious paper art or repeats the headline.
