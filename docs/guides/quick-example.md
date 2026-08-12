---
id: quick_example
title: Quick example — fork, invoke, own
summary:
  Agent playbook for onboarding Step 2: wait for a one-click install/fork of a
  zero-auth example package, invoke the user's installed copy, show the result,
  explain ownership, and offer optional triggers without recommending one.
category: platform
---

# Quick example — fork, invoke, own

<!--
Agent notes — for AI agents driving onboarding Step 2 from this page:

- The person already started a one-click install/fork on /onboarding. Your job
  is to wait until that package is in their account, invoke THEIR copy, show
  the result, and teach that Kody turns agent work into owned packages.
- Keep messages short — under roughly 120 words.
- NEVER poll, sleep, or retry on a timer. Search once; if the package is not
  found yet, ask them to say when install finished and try once more.
- Invoke with packages.invoke({ kodyId, exportName, params }) against the
  installed/forked package. Do NOT rely on a bare platform @kody/* static
  import for packages that need packageStorage (for example personal-capture) —
  that fails until the package is forked into their account.
- Do not recommend one trigger over another. Offer webhook, Kody app, cron, or
  skip, and let them choose.
- Do not create extra packages during this loop unless they ask.
- Paths like /onboarding are relative to the origin you fetched this guide from.
-->

This guide is the playbook for a Kody account's first build: fork a ready-made
zero-auth example, run it once, and see that the result is a package the person
owns — before connecting GitHub, Google, or other OAuth services.

The person may have arrived from `/onboarding` Step 2 ("Try a quick example") on
the same origin this guide was fetched from. After they pick a card, install
starts in the browser; they can paste a prompt into their agent while install is
still finishing.

## Before you start

The account needs a verified email and an authorized MCP host. The one-click
install on `/onboarding` forks the listing into their account; wait for that
package to be searchable before invoking.

## Step 1 — Confirm the install

Search for the package by the kody id from the prompt (for example
`local-conditions`, `hn-pulse`, or `personal-capture`).

If it is missing, tell them install may still be finishing (~tens of seconds)
and ask them to say when the page shows installed. Try the search **once** more
after they confirm. Do not poll.

## Step 2 — Invoke their copy

Use keyless `packages.invoke` with that kody id. Example shapes:

- **local-conditions** —
  `packages.invoke({ kodyId: "local-conditions", exportName: "getLocalConditions", params: { place: "Salt Lake City" } })`
- **hn-pulse** —
  `packages.invoke({ kodyId: "hn-pulse", exportName: "getTopStories", params: { limit: 5 } })`
- **personal-capture** —
  `packages.invoke({ kodyId: "personal-capture", exportName: "capture", params: { text: "Onboarding first build" } })`,
  then `listCaptures`

Show a short summary of the result.

## Step 3 — Name the ownership lesson

In one short message, explain that the package lives in **their** account: they
can edit it, hang triggers on it, or fork something else. This is the permanence
lesson for onboarding — not a practice run.

## Step 4 — Offer triggers (optional)

Ask whether they want to hang a trigger on it: webhook, Kody app, cron, or skip
for now. List the options; do **not** recommend one. If they skip, point them at
`/onboarding` Step 3 to connect real services (GitHub, Google, Slack, Notion,
and more).

## Troubleshooting

- **Package not found** — install still in flight, or they are on a different
  account than the browser session. Wait for their "finished" message; one
  retry.
- **`packageStorage` / platform invoke errors** — they invoked the platform
  `@kody/*` copy instead of their fork. Search again and invoke by kody id from
  their account.
- **Adaptation required** — rare for these trusted examples. Open the inert fork
  with a repo session only if install reported adaptation was required.
