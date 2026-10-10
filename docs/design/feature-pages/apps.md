# Apps feature concept

## Position

Headline: **Give your work a place to happen.**

Pitch: Ask your agent for a tool that fits the job. Kody hosts the app, keeps
its data, and connects it to the packages you already use.

Primary action: **Build an app** Secondary action: **Try the demo**

The selling point is a useful, repeatable surface for human action. A person
should leave remembering that their agent can make a small tool they return to,
with real controls and saved data. This page is about using that tool, rather
than watching code get generated.

## Visual direction and interaction

Use the pink lantern color `oklch(0.72 0.24 345)`, Bricolage Grotesque for the
headline and Wix Madefor Text for controls and copy. A warm paper page, deep
plum text, and a large borderless pink app canvas. Keep the koala small, holding
the pink lantern beside the app's launch control. The lantern's light can meet
the app edge, but should not replace a meaningful interface element.

The main scene is a working **project intake app**, not a dashboard screenshot
or a chat/code split. A wide form occupies the hero's right two thirds, slightly
extending below the first viewport. It contains a project name field, three
selectable job types, a deadline selector, a short brief, and **Save brief**. A
small inset browser address reads `you.kody.run/packages/project-intake`. A
clearly visible **Demo** label distinguishes it from an actual account.

Initial data: Project name **Autumn launch**, job type **Website**, deadline
**October 28**, brief **A product page for the new collection.** The visitor
edits any field and saves. The form turns into a useful, printable brief with
the actual inputs, **Edit brief**, and **New brief**. Saving is local to the
demo and does not call any connected service. A single concise status reads
**Saved in this demo**. Do not use fake server logs, invented build durations,
confetti, or pretend live integrations.

A second control switches between **Intake form** and **Saved briefs**. Saved
briefs include the visitor's new item, and reopening it proves continuity within
the demo. Keep state in memory for the page session or explicitly local browser
storage. Do not imply the marketing demo is saving into a real Kody package.

This scene is different from the other feature pages: it is a full, useful
miniature app with a direct edit/save/open loop. No connection graph, credential
boundary, event timeline, memory cards, or code workbench.

## Four page beats and copy

### 1. Hero and usable app

**Give your work a place to happen.**

Ask your agent for a tool that fits the job. Kody hosts the app, keeps its data,
and connects it to the packages you already use.

**Build an app** / **Try the demo**

The live demo described above supplies the evidence. Avoid a second headline
above the canvas.

### 2. A tool with a reason to come back

**Open it. Do the thing. Come back tomorrow.**

A form to collect a brief. A tracker to update a project. A small calculator
your team uses every week. Give the work a screen of its own, with data that
stays with the package.

Use one horizontally expansive app view, **Saved briefs**, carrying the
visitor's saved item down the page if practical. Show the record's actual name,
job type, and deadline. This connects the claim about saved data to the
interaction, without invented analytics. The demo's local nature stays visible.

Link: **How app data works** to package apps documentation.

### 3. The same tool, for the people who need it

**Share the tool you made.**

Give someone Use access to run your package, Contribute access to edit it, or
Manage access to publish and control access.

Show a compact, readable access list with a role selector for one sample
collaborator, **Morgan**, and a persistent description under the selector. Use:
**Can read the source and run the package.** Contribute: **Can also edit the
package.** Manage: **Can also publish and manage access.** This is a local
illustration, not a working invitation. No fake invite success state.

Adjacent small text: **Package access does not reveal secret values.**

Link: **Share a package** to the sharing guide. Do not present Use as opaque
source-free access. Do not turn this section into an enterprise compliance
pitch.

### 4. Make the next useful thing

**What would you open every week?**

One editable prompt input, initialized to: **Build a project intake app that
saves a brief I can reopen and edit.**

Action: **Build this in Kody**. Wire to an existing supported authenticated
creation flow if it can accept this prompt; otherwise use the actual
signup/start flow and offer a truthful **Copy prompt** action. Never make a dead
prompt-to-app button.

Below, two plain links: **Read the app guide** and **Browse community
packages**. No extra closing slogan.

## Personal, business, and enterprise relevance

These are suitable scenarios, not existing customer case studies or guaranteed
ready-made templates:

- Personal: A reading tracker, household project checklist, or hobby inventory.
  The reason to use an app is editing structured records without repeating chat
  instructions. Package storage supports saved data.
- Business: A project intake form, internal estimator, or review queue.
  App-specific validation and any connected provider work must be built and
  verified. The demo proves only the intake interaction.
- Enterprise: A narrow internal tool shared with named people or teams, with
  package-level Use, Contribute, and Manage access. The docs support scoped
  grants and outside collaborators. They do not establish SSO, audit
  certifications, enterprise deployment regions, or turnkey enterprise
  governance, so make none of those claims.

Avoid adding three generic audience cards. The intake scenario and access
section naturally carry these meanings. If audience examples are needed, use
selectable example prompts inside the last input instead.

## Evidence and claim boundaries

Repository sources reviewed:

1. `docs/guides/package-apps.md:23-35`: apps are hosted Worker fetch handlers,
   optional browser client/static files, and runtime access. This supports
   hosted interactive applications, not arbitrary Node processes or a universal
   website host.
2. `docs/guides/package-apps.md:66-85`: package-owned durable data via
   `packageStorage()`, browser entry, assets, reusable exports. Supports an app
   with saved records and backend logic.
3. `docs/guides/package-apps.md:87-98`: hosted URL is
   `https://{username}.kody.run/packages/<package-name>/…`; opening from
   signed-in Kody attaches a short-lived session. Do not claim anonymous/public
   app access just because a URL exists.
4. `docs/guides/package-apps.md:41-64`: integrations and secret state are
   checked, authentication is smoke-tested, then the app is built. Do not claim
   that external services work without connection or auth setup.
5. `docs/guides/package-apps.md:178-511`: complete worked notes app with a form,
   stored records, routes, and hydrated counter. This is the concrete
   implementation example grounding the edit/save/open demo, whose
   project-intake content is a proposed marketing illustration.
6. `docs/guides/package-apps.md:587-612`: framework-agnostic Worker host,
   explicit framework dependencies, restrictions on Node
   process/filesystem/TCP/dev server modules. Avoid framework exclusivity and
   arbitrary software hosting claims.
7. `docs/guides/package-apps.md:917-925` and `999-1006`: browser and Worker
   bundles are separate graphs; browser code cannot import runtime or package
   secrets. Supports keeping privileged work in backend modules, not a blanket
   claim that application authors cannot leak data.
8. `docs/guides/package-authoring.md`, sections `Package docs`,
   `Package visibility`, `Secret-using packages`, and `Verify your publish`:
   source and agent documentation, private-by-default packages, approval
   requirements, and actual surface testing. Public package visibility describes
   world-readable/forkable source, not proof of anonymous app serving.
9. `docs/guides/package-sharing.md`, sections `Presets`,
   `What a collaborator can do`, and `Cross-org imports`: Use includes source
   read/run; Contribute adds writes; Manage adds publish/delete/access. Grants
   do not reveal secret values. Outside collaborators have scoped access, org
   billing and budgets apply. Cross-org package imports are not supported even
   with a grant.

No checked-in standalone product app example was identified in the initial file
scan. The detailed notes and counter examples in the guide are the evidence used
here. Do not represent this concept as an existing shipped intake template.

## Search-intent hypotheses

No search volumes or ranking promises are implied:

- **AI built internal tools**: visitor wants a useful custom interface tied to
  their work. Hero and working intake demo answer the intent.
- **build an app with an AI assistant**: visitor wants to go from a request to
  something they can open again. Explain hosted app plus saved data.
- **host an app built by an AI agent**: technical visitor wants runtime/URL/auth
  specifics. Link directly to package app docs and use accurate Worker language
  in metadata or technical detail.
- **share custom internal tools with a team**: visitor needs role distinctions.
  Show exactly what package grants permit.

Suggested title: **Apps built for your work | Kody** Suggested description:
**Turn a useful idea into a hosted Kody app with saved data, package logic, and
access for the people who need it.**

## Links

Registered site routes:

- App docs: `/docs/package-apps`
- Sharing docs: `/docs/package-sharing`
- Authoring docs: `/docs/package-authoring`
- Community: `/community`
- Related feature pages: Packages for reusable logic, Integrations for connected
  services, Secrets for credentials, Triggers for scheduled/event-driven work.
  Use `/features/packages`, `/features/integrations`, `/features/secrets`, and
  `/features/triggers`.

## Accessibility and motion

Use real labels, text inputs, select controls, forms, buttons, and visible
keyboard focus. Keep the form/save/open loop usable without dragging, hovering,
or animation. Announce save status politely and move focus deliberately to the
saved brief heading, with Edit returning focus to the first field. Validate
empty project name with a linked inline error. Roles use text as well as color.

Use dark text on the pale pink background and verify actual contrast, especially
bright magenta actions. Bright pink is an accent, not a small-text color. Layout
stacks naturally on mobile with controls at least 44px high. No horizontal
canvas requiring precision panning.

The only optional motion is a short form-to-brief transition and subtle lantern
illumination after save. Under reduced motion use immediate state changes, with
no floating lantern, pulsing glow, or scroll-controlled transformations. All
page information and actions remain visible with JavaScript disabled, while the
demo displays an honest static example.
