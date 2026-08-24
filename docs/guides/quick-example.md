---
id: quick_example
title: First build — ad hoc execute, then persist
summary:
  Agent playbook for onboarding Step 3: run one useful ad hoc execute against
  something they gave Kody access to (or whatever they ask for if they
  skipped), show the result, persist that working code as a package they own,
  and offer optional triggers without recommending one.
category: platform
---

# First build — ad hoc execute, then persist

<!--
Agent notes — for AI agents driving onboarding Step 3 from this page:

- The person already gave Kody access on /onboarding Step 2 (featured official
  remotes, or a custom server), installed a Just-try-Kody zero-auth example, or
  skipped so they could try an ad hoc request first. Connect copies the matching
  official helper into their account — they run that owned copy, not kody:@kody/*.
- Your job is one useful execute call, a short result, then persist that
  working code as a package they own. That owned package is the point of Kody.
- Keep messages short — under roughly 120 words.
- NEVER poll, sleep, or retry on a timer. If access is still authorizing, ask
  them to say when /onboarding shows Connected and try once more.
- Discover tools with search or mcp_server_list. Call them from execute as
  kody.mcp["notion"].tool_name(...), kody.mcp["linear"].tool_name(...), or the
  matching connected server name.
- Persist with package_save after the ad hoc call works. Do not invoke official
  @kody/* packages — person accounts run the owned fork from Connect, or a new
  package_save.
- Do not recommend one trigger over another. Offer webhook, Kody app, cron, or
  skip, and let them choose.
- Do not create extra packages during this loop unless they ask.
- Paths like /onboarding are relative to the origin you fetched this guide from.
-->

This guide is the playbook for a Kody account's first build: run one useful ad
hoc request, then save that working code as a package the person owns — after
they give Kody access, or after they skip that step.

The person may have arrived from `/onboarding` Step 3 ("Try it, then persist")
on the same origin this guide was fetched from. They can paste a prompt into
their agent as soon as they reach that step.

## Before you start

The account needs a verified email and an authorized MCP host. If they gave Kody
access on `/onboarding` Step 2 (featured or custom), confirm the server is ready
with `mcp_server_list` before calling its tools. If they installed a
Just-try-Kody example, invoke that owned package. If they skipped, ask what they
want to try and use whatever tools are already available.

## Step 1 — Confirm the connection

If they named a service they gave Kody access to, look it up once with
`mcp_server_list` (or `search` for `mcp:notion`, `mcp:linear`, `mcp:atlassian`,
`mcp:stripe`, `mcp:sentry`, or `mcp:canva`).

If the server is still authorizing, tell them to finish the provider window and
say when `/onboarding` shows Connected. Try the list **once** more after they
confirm. Do not poll.

If they skipped Step 2, ask one short question about what they want to try
instead of adding a server yourself.

## Step 2 — Run one ad hoc execute

Use `execute` for a single useful call. Prefer the connected MCP tools:

- **Notion** — search a page they mention, or list recent pages they can access.
- **Linear** — list a few issues, or summarize what is in progress.
- **Atlassian** — list Jira issues or Confluence pages they can already see.
- **Stripe** — list recent customers, invoices, or payments they can access.
- **Sentry** — list recent issues, or summarize one they name.
- **Canva** — list recent designs or folders they can access.

Show a short summary of the result. Do not create a package until this call
works.

## Step 3 — Persist the working code

Save that working module as a package they own:

- `package_save` when you are writing the first version, or
- the owned helper Connect already copied into their account when that is
  closer. Do not invoke `kody:@kody/*`.

Name the package after the job it does. Then confirm it is searchable as theirs.

## Step 4 — Name the ownership lesson

In one short message, explain that the package lives in **their** account: they
can edit it, hang triggers on it, or write another. This is the permanence
lesson for onboarding — not a practice run.

## Step 5 — Offer triggers (optional)

Ask whether they want to hang a trigger on it: webhook, Kody app, cron, or skip
for now. List the options. If they skip, they are done with Get started.

## Troubleshooting

- **Server not connected** — the authorize window is still open, or they are on
  a different account than the browser session. Wait for their "Connected"
  message; one retry.
- **No connected tools** — they skipped Step 2, or the server name is not one of
  the Step 2 cards. Ask what they want, or send them back to
  `/onboarding#connect-mcp`.
- **`package_save` rejected** — the ad hoc module is incomplete. Keep the
  execute evidence, fix the package files, and save again. Do not invent extra
  packages.
