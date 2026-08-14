---
id: google_oauth
title: Google OAuth interactive guide
summary:
  Interactive transcript of a coding agent walking a naive user through
  Lane B Google OAuth for Gmail inbox reading: official guides first,
  one console step at a time, prefilled /connect/oauth, refuse secrets
  in chat, then a Gmail profile smoke test.
category: platform
---

# Google OAuth interactive guide

<!--
Agent notes — for AI agents explaining or recreating this loop:

- The web page at /guides/google-oauth is an interactive transcript of the
  same story. This markdown is the playbook.
- Do not invent Google console UI, URLs, or scopes. Load provider_google,
  oauth, and integration_bootstrap via coding_guide_get and follow those.
- Honest Lane B reason: inbox reading (gmail.readonly) is outside the
  built-in Google scope menu. Do not pretend Calendar-only needs a BYO
  client, and do not start already knowing "Lane B" or the 7-day trap —
  discover those from the guides.
- Walk the user one console step at a time. Wait for "done" between:
  Cloud project → enable Gmail API → Google Auth Platform Get started →
  Web client with redirect https://kody.codes/connect/oauth → Data Access
  gmail.readonly → Audience test user → Publish to Production (7-day
  Testing refresh-token trap / invalid_grant).
- Send a prefilled /connect/oauth URL from provider_google with
  gmail.readonly, gmail.googleapis.com in allowedHosts, confidential
  flow, access_type=offline, and prompt=consent. Client ID and secret
  go on that Kody form only — never accept them in chat.
- After authorize, smoke-test with createAuthenticatedFetch('google')
  against the Gmail profile URL from provider_google. Do not create a
  package in this story; the payoff is a working integration.
- Tool names exposed to the agent are only search or execute. Nested
  calls (coding_guide_get, createAuthenticatedFetch) live inside execute
  code. Every tool needs a note. Search markdown starts with
  "# Search results"; entity detail with "# Capability —"; execute text
  with "conversationId: ".
- search and execute can take a short memoryContext (task plus a couple
  of entities). This story needs no memory writes and may have zero
  memories.
-->

Kody can connect Google two ways. The built-in path covers Calendar and other
allowed scopes without a Cloud project. Inbox reading needs a bring-your-own
OAuth client (Lane B) because `gmail.readonly` is outside that menu.

This page is the playbook. The same story is an interactive transcript at
`/guides/google-oauth` on the origin you fetched this guide from.

## The loop

1. **Ask for inbox access.** The user wants Kody to read Gmail for invoices (for
   example from Acme) and does not know the steps.
2. **Look up the guides.** Search for Google / Gmail / OAuth, open
   `coding_guide_get` entity detail, then load `integration_bootstrap`, `oauth`,
   and `provider_google`.
3. **Choose Lane B.** Built-in Google does not cover inbox reading. Walk Google
   Cloud and Google Auth Platform one step at a time: project, enable Gmail API,
   branding and External audience, Web client with redirect
   `https://kody.codes/connect/oauth`, Data Access scope
   `https://www.googleapis.com/auth/gmail.readonly`, test user while Testing,
   then Publish to Production so refresh tokens are not limited to seven days.
4. **Connect on Kody.** Send a prefilled `/connect/oauth` URL (confidential,
   `gmail.readonly`, `gmail.googleapis.com`, `access_type=offline`,
   `prompt=consent`). Paste client ID and secret only on that form. Refuse any
   secret pasted in chat.
5. **Smoke-test.** After authorize, call `createAuthenticatedFetch('google')`
   against `https://gmail.googleapis.com/gmail/v1/users/me/profile`. Later
   reconnects can use `/connect/oauth?provider=google` alone.

## When to load this guide

Load `google_oauth` when someone wants a teaching walkthrough of Google OAuth
for Gmail inbox reading, or when an agent should see how to coach a user through
Lane B without inventing console steps. For the authoritative console checklist,
load `provider_google`. For the generic OAuth path, load `oauth`. For ordering
before packages, load `integration_bootstrap`.
