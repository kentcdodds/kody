---
id: google_oauth
title: Google OAuth interactive guide
summary:
  Interactive transcript of a coding agent walking a naive user through
  Google OAuth for Gmail inbox reading: official guides first, one
  console step at a time, prefilled /connect/oauth, refuse secrets in
  chat, then a Gmail profile smoke test.
category: platform
---

# Google OAuth interactive guide

<!--
Agent notes — for AI agents explaining or recreating this loop:

- The web page at /guides/google-oauth is an interactive transcript of the
  same story. This markdown is the playbook.
- Do not invent Google console UI, URLs, or scopes. Open
  `provider_google:guide`, `oauth:guide`, and `integration_bootstrap:guide`
  with `search({ entity })` and follow those.
- Inbox reading (gmail.readonly) needs a Google Cloud OAuth client the
  user owns. Do not start already knowing the 7-day Testing-status trap —
  discover that from the guides.
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
- Tool names exposed to the agent are only search or execute. Official
  guides load through `search({ entity: "{id}:guide" })`. Nested calls
  such as `createAuthenticatedFetch` live inside execute code. Every tool
  needs a note. Search markdown starts with "# Search results"; guide
  entity detail with "# Guide —"; execute text with "conversationId: ".
- search and execute can take a short memoryContext (task plus a couple
  of entities). This story needs no memory writes and may have zero
  memories.
-->

Connecting Google means creating an OAuth client the user owns in Google Cloud,
then finishing on `/connect/oauth`. Inbox reading needs the `gmail.readonly`
scope on that client.

This page is the playbook. The same story is an interactive transcript at
`/guides/google-oauth` on the origin you fetched this guide from.

## The loop

1. **Ask for inbox access.** The user wants Kody to read Gmail for invoices (for
   example from Acme) and does not know the steps.
2. **Look up the guides.** Search for Google / Gmail / OAuth, then open
   `provider_google:guide`, `oauth:guide`, and `integration_bootstrap:guide`.
3. **Walk the console.** Create the OAuth client in Google Cloud and Google Auth
   Platform one step at a time: project, enable Gmail API, branding and External
   audience, Web client with redirect `https://kody.codes/connect/oauth`, Data
   Access scope `https://www.googleapis.com/auth/gmail.readonly`, test user
   while Testing, then Publish to Production so refresh tokens are not limited
   to seven days.
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
the console without inventing steps. For the authoritative console checklist,
load `provider_google`. For the generic OAuth path, load `oauth`. For ordering
before packages, load `integration_bootstrap`. For drafts the agent must not
send (Google has no drafts-only scope), load `locked_gmail_drafts`.
