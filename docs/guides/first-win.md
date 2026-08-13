---
id: first_win
title: Email and memories — welcome email, reply, memories
summary:
  Optional agent playbook: send a welcome email, point the person at their own
  inbox to reply, look the reply up when they say it is sent, save what matters
  as memories, then offer a one-click integration. Onboarding Step 2 uses the
  quick-example fork→invoke flow instead; load this when someone wants the
  email loop. Includes the no-polling rule and troubleshooting for missing mail
  and unbound tools.
category: platform
---

# Email and memories — welcome email, reply, memories

<!--
Agent notes — for AI agents driving the optional email loop from this page:

- Onboarding Step 2 climax is /guides/quick-example (fork → invoke → own).
  Use this guide only when the person wants the email-and-memories loop.
- You drive the whole loop. The person stays in this chat; they should not need
  to go back to the Kody web page for anything except the optional integration
  connect at the end.
- Work one step at a time and confirm each step out loud before moving on. Keep
  messages short — under roughly 120 words.
- NEVER poll, sleep, retry on a timer, or "wait" for the reply to arrive. Tell
  the person to come back and say "replied", then look it up. Repeated lookup
  calls while they are away are the single worst failure mode here: they burn
  tokens, they look broken, and they add nothing that one lookup after "replied"
  does not.
- Every Kody path below (`/onboarding`, `/connect/oauth`, `/account/email`) is
  relative to the origin you fetched this guide from. Resolve them against that
  origin; never send someone to a different Kody deployment.
- Use the exact subject from step 1 whenever you refer to the email, so the
  person can search their inbox for it.
- Save memories only after the reply is in hand, and say what you saved.
- Do not create packages, jobs, or workflows during the first win. This is one
  short loop, not a build session.
-->

This guide is an optional playbook for exercising stored mail and durable
memory: the assistant introduces itself over email, the person replies from
their normal email client, and the answers become memories that follow them into
every agent they connect later. For the default post-connect climax (fork a
zero-auth example and invoke a package you own), use
[`quick-example`](./quick-example.md) instead.

Paths below are relative to the same deployment origin this guide was fetched
from; everything after this happens in their agent, not on the web page.

## Before you start

The account needs a verified email address and an authorized MCP host. If
`email_send` reports that the account email is unverified, stop and tell the
person to finish verification first — the rest of this loop cannot work without
it.

## Step 1 — Send the welcome email

Call `email_send` on your own account address with a subject the person can find
by searching their inbox:

```text
Welcome to Kody — reply to introduce yourself
```

Keep the body short and personal, and ask three questions in it: their name,
what they do for work, and what they do for fun. Close by inviting a reply to
that same message.

`email_send` only ever mails the account's own address, and the from address is
the account's platform inbox (`{username}@<platform domain>`). Note both the
subject you used and the from address the response reports — the next step needs
them.

Then tell the person what you sent, quoting the subject verbatim.

## Step 2 — Point them at their own inbox

The reply comes from the person's **personal** email client, not from Kody. Tell
them, in one short message:

- Open the inbox for the email address on their Kody account.
- Look for the subject **Welcome to Kody — reply to introduce yourself** (quote
  it exactly, and name the from address you saw in step 1).
- Check spam or promotions if it is not in the inbox — first mail from a new
  domain lands there sometimes.
- Reply with their name, work, and something they do for fun. Thirty seconds is
  plenty.

## Step 3 — Wait for them, not for the mail

**Do not poll.** Do not loop on `email_message_search`, do not schedule a job to
watch for the reply, and do not tell the person to hold on while you check.
Nothing in Kody answers by itself, so there is nothing to watch.

Instead, end your message with an explicit hand-off: ask them to come back to
this chat and say **"replied"** when they have sent it. Then stop and let them
go.

## Step 4 — Look the reply up

When they say they replied, find it once:

- `email_message_search` with a query from the subject (or `email_message_list`
  filtered to inbound mail), then
- `email_message_get` for the full body of the match.

If nothing is stored yet, say so plainly and ask them to say "replied" again in
a moment rather than checking on a timer yourself. Mail is stored on delivery,
so a fresh reply can take a beat to land.

## Step 5 — Save what matters as memories

Turn the reply into durable memories — not values, not a package. Memories are
the right home for "who this person is" facts, and they surface to every agent
connected to the same account.

Call `meta_memory_verify` first to see what already exists, then
`meta_memory_upsert` for each fact worth keeping: their name, their work, what
they do for fun, and anything else the reply volunteered (timezone, tools they
live in, what they want automated).

Then confirm out loud, in one short list, exactly what you saved. This is the
moment the whole loop pays off, so make it visible rather than silent.

## Step 6 — Offer the next step

The first win is done. Offer one concrete next step and let them choose:

- **Connect a built-in integration in one click.** Kody hosts the provider app,
  so there is nothing to register. Send them to `/connect/oauth?provider=<slug>`
  on the same origin this guide came from (for example `provider=github` or
  `provider=google`), then verify the connection with a small ad hoc `execute`
  call.
- **Bring their own OAuth app or API key** when they need scopes or rate limits
  the built-in app does not offer — load `coding_guide_get` with
  `guide: "oauth"`, or the matching `provider_*` guide.
- **Ask what they want automated** and use `coding_guide_get` with
  `guide: "package_lifecycle"` to pick between a one-off `execute`, a community
  fork, and a new package.

## Troubleshooting

**The email never arrived.** Have them check spam and promotions first, and
confirm the address on their Kody account is the inbox they are looking at. Kody
also keeps its own copy: `/account/email` shows the stored outbound message, so
the subject is recoverable even when the personal copy is lost. Sending again is
fine — say that you are resending so a duplicate is not a surprise.

**Their reply is not in Kody.** Confirm they replied to the welcome message
rather than composing a new mail to a different address, and confirm the from
address matches the account inbox. A reply from an address that is not on the
account is not stored as theirs.

**Kody's tools are not available in the host.** Claude Desktop (and some other
hosts) bind MCP tools when a conversation starts, so a host that authorized
mid-conversation often needs a **brand new chat** before the Kody tools appear.
Have them start a fresh chat and paste the prompt again. If tools still do not
appear, the authorization did not finish — send them back to `/onboarding` to
reconnect.

**Nothing seems to happen on its own.** That is by design. Kody stores mail,
memories, credentials, and code; it makes no inference calls of its own. Every
step in this loop happens because an agent asked for it.

## Try it

Paste this into the agent connected to your Kody account, swapping in your
deployment's origin if it is not kody.codes:

> Ask the connected Kody server to read https://kody.codes/guides/first-win and
> then walk me through the optional email-and-memories loop, one step at a time.
