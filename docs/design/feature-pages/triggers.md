# Triggers page concept

## Core direction

Headline: **Give the next step a starting signal.**

Pitch: **A purchase lands. An issue opens. An email arrives. Kody runs the
package you built, even when the chat is closed.**

Primary action: **Connect your agent** using the site's existing onboarding
destination. Secondary action: **Try a trigger** jumps to the hero demo.

Make this the most kinetic of the feature pages. Its subject is a moment
crossing into action, not a calendar or an agent thinking. Use the gold lantern
color, `oklch(0.78 0.16 96)`, as a broad field behind the hero and as the active
event path. Put dark ink on gold, not white. Bricolage Grotesque carries the
headline and large event phrases. Wix Madefor Text carries controls, copy, and
results. Reuse the existing koala and gold lantern artwork as a small
participant watching the incoming signal, not another giant mascot illustration.

## Unique hero and interactive demo

A wide, editorial event ledger occupies the hero, partially under the headline.
It has three generously spaced columns: **When**, **Run**, **Result**. Thin
horizontal tracks lead from a chosen event into its package and then its actual
outcome. Avoid a node canvas, dashboard shell, floating card collage, or
code-editor hero. One selected row is gold; the other event rows are quiet ink
on warm paper. The ledger should feel like a usable explanation, not a
screenshot of a nonexistent product UI.

Four radio-style choices select the event and update the complete track:

- **A purchase completes** → Purchase thanks → **Thank-you draft ready**.
  Detail: “Verified payment. Draft saved for review.”
- **An issue opens** → Sentry triage → **Issue ready for investigation**.
  Detail: “Verified delivery. Follow-up work queued.”
- **An email arrives** → Inbox router → **Matching mail routed**. Detail:
  “Plus-tag matched. Handler started.”
- **The daily check is due** → Flake Hunter → **No flakes found**. Detail: “Scan
  complete. No notification.”

Below the row, a native button labeled **Run example** advances a short
deterministic local simulation. The small label **Example** is always visible so
nobody mistakes this for a live connected account. Button does not call a
provider or create data. An optional **Show a flake** checkbox on the daily
choice changes the outcome to “Investigation started,” with “Agent called after
the scan found a signal.” This contrast communicates the useful boundary between
cheap ordinary code and optional reasoning without cost promises.

A second sample for Inbox router, **Use another address**, returns “No matching
tag. No action.” This is more useful than endless ambient animation: a visitor
can see that the package decides whether the event warrants work.

Animation: one small gold lantern glow moves once from When to Run to Result,
with each step becoming readable immediately. Never automatically loop. Result
persists. Above the selected track, a plain text phrase updates from “Waiting
for a purchase” to “Purchase verified” to “Draft ready.” No stopwatch, invented
latency, counters, or fake live feed.

Mobile: column labels become stacked labels within one selected track, followed
by the result. Event choices wrap as full-width buttons or a compact radio
group. Keep the complete story visible without horizontal scrolling.

## Page beats and copy

### 1. The moment is the trigger

Hero copy and ledger above. The purchase row is selected initially, making this
event-led at first paint. Scheduling is present but not privileged.

### 2. Use the signal you already have

A tall split composition: large plain event phrases down the left, short
descriptions aligned on the right. This is the one explanatory section, not
another card grid.

**Your tools can call it.** “Give a package a webhook for Sentry issues, Stripe
checkouts, or another system that can send a request.”

**Your inbox can start it.** “Every Kody account has an email address. Route
incoming mail by sender or plus-tag, then run the package that handles it.”

**Your packages can pass it on.** “One package can emit an event. Other packages
in your account can react, each with its own job to do.”

**The clock works too.** “Run a saved check on a schedule, or queue one task for
later.”

Link the relevant sentence to `/docs/triggers` or the worked example at
`/docs/flake-hunter`.

### 3. Keep the routine in code

A large quiet ink panel breaks the gold rhythm. It shows two vertically aligned
branches from a scheduled scan: “Clean” ends in empty space with “No
notification.” “Flake found” ends in an agent icon with “Start an
investigation.” The meaningful blank space makes silence the outcome.

Heading: **Let code do the watching.** Copy: “A trigger starts your package
without a model deciding whether to run it. The package can call an agent when
the work needs one.” Evidence link: **See how Flake Hunter works**.

Small adjacent real-example link: **See Sentry triage**. Its excerpt: “Receive
the issue, acknowledge it, then queue the longer investigation.”

No “zero AI costs,” “free runs,” or “no tokens ever” badges. Handler code can
call models, and agent investigations have their own costs.

### 4. Make it yours, then see it run

Use a single wide activity row as a supporting illustration rather than another
dashboard. Label it “Example run,” show the package, event type, and outcome.
Beside it:

Heading: **Test it before you leave it running.** Copy: “Run the handler once,
check the result, then enable the trigger. Find recent runs and failures in
Activity.” Actions: **Connect your agent** and **Read the trigger guide**.

Only show controls actually supported by the chosen trigger, not one universal
“pause everything” switch. Jobs can be enabled or disabled, webhooks have their
own settings, and workflows can be cancelled.

## Audience relevance

Keep these inside the examples, not separate Personal / Business / Enterprise
pricing-like cards.

- Personal: Forward mail to a plus-tag, run a useful daily check, or defer one
  task until Friday. Proven primitives, example automations require a package.
- Business: A verified purchase produces a draft on a relevant Gmail thread. The
  documented purchase-thanks package is draft-only. Do not make the visual send
  mail.
- Engineering teams and enterprise evaluators: Sentry delivery starts
  package-owned triage, repo events can start downstream work, and runs are
  inspectable. Frame this as engineering applicability, not an enterprise
  edition or a promise of shared team administration, compliance certification,
  SLA, or universal exactly-once delivery.

## Research facts and exact source paths

- `docs/guides/triggers.md`: four mechanisms, jobs, workflows, inbound webhooks,
  subscriptions. Prefer the event that describes the moment. Jobs ship in
  package manifest. Inbox emits `email.message.received`. Recent runs and
  failures are in `/account/activity`.
- `docs/guides/package-subscriptions.md`: subscriptions invoke package runtime
  with owned context/storage/secrets. Package-emitted topics fan out only within
  the same user's saved packages. Package events are asynchronous/durable with
  per-subscriber idempotency; infrastructure retries and terminal handler
  failures have different semantics. Platform topics vary, some are best-effort.
  Metadata filters for package topics must match exactly. This is not a global
  all-events reliability guarantee.
- `docs/use/workflows.md`: workflows can run later or support longer one-shot
  work. Explicit idempotency keys deduplicate matching identities for the same
  user. Runs can be inspected/cancelled. Plan concurrency limits exist. Do not
  promise limitless background work or perpetual duration.
- `docs/guides/flake-hunter.md`: daily 4am America/Denver scan for previous 24
  hours of CI, one investigation on a flake signal, silence on a clean day.
  Kent's copy can call a Cursor Cloud Agent. A fork may just scan and notify.
  This is the clearest proof of code first, agent when useful.
- `docs/guides/sentry-issues.md`: HMAC verification, package-owned ingress,
  quick acknowledgement, durable downstream triage. Kent's copy wakes Cole and
  does not directly auto-spawn Cursor from webhook delivery. Do not claim
  webhook receipt itself fixes an issue.
- `docs/guides/agent-inbox.md`: automatically provisioned inbox, preserved
  plus-tags, metadata-first event handlers, body fetched only as needed. Kent's
  handler ignores cold mail, but that is package logic, not every inbox's
  universal default.
- `docs/guides/purchase-thanks.md`: real public example uses a Stripe webhook
  with fetch-back verification, then creates a Gmail draft, never sends. A
  second documented shape emits an owned purchase topic for another package to
  subscribe. Do not depict the real example as already using two packages.
- Additional supporting references: `docs/use/webhooks.md`,
  `docs/use/email-primitives.md`, `docs/guides/package-lifecycle.md`,
  `docs/guides/locked-gmail-drafts.md`.

The trigger overview says “no tokens spent,” but its worked examples establish
the narrower honest claim: dispatch and ordinary package execution do not
require model inference, while packages can deliberately call models or agents.
Use the narrower wording throughout.

## Related feature links

- Packages: the saved code a trigger runs, reuse existing packages page
  destination.
- Secrets: signing secrets and credentialed webhook URLs, reuse existing secrets
  destination.
- Integrations: connected services used by the handler, if that feature page
  exists.
- Activity: contextual product link for signed-in users only, do not market a
  public feature route that does not exist.
- Guides: trigger chooser, Sentry Issues, Agent inbox, Purchase thanks, Flake
  Hunter, workflows reference.

## Search-intent hypotheses

These are content hypotheses based on the documented problem, not researched
demand or volume claims:

- “run AI automation when webhook arrives” / “event driven AI automation”:
  explain that events invoke a package and it chooses whether an agent is
  needed.
- “email trigger for AI agent”: show plus-tags and selective handling with the
  Agent inbox guide.
- “schedule code written by AI”: package-owned job, runtime independent of an
  open chat.
- “Stripe purchase thank you draft automation”: exact worked example, draft-only
  boundary.
- “Sentry webhook AI triage”: event verification followed by durable work, not
  guaranteed autonomous fixes.

Suggested page title: “Triggers: run your packages when things happen | Kody”.
Description: “Run Kody packages from webhooks, incoming email, package events,
or a schedule. Test the handler, then follow each run in Activity.”

## Accessibility and reduced motion

Use native buttons and radio inputs with a visible selected state that includes
text or a checkmark, not color alone. Keep gold under dark ink and verify actual
contrast in rendered implementation. Give event/result changes one polite live
region, announce the final result rather than every animation frame. No
auto-play, flashing, or pointer-only controls. Focus remains on Run example
after activation. Honor reduced motion by switching states instantly and
removing travel/glow animations. Provide all meaning as text with decorative
lantern art hidden from assistive tech. Responsive layout must preserve When →
Run → Result reading order. The illustrated result is available without running
the animation.
