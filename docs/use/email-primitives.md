# Email primitives

Kody has a storage-only email surface for Cloudflare Email Service and Email
Routing. It can send from verified identities, receive routed mail, store parsed
messages, and quarantine unknown senders.

## Capabilities

Use the MCP `email` domain:

- `email_inbox_create` creates an inbox and routable alias.
- `email_inbox_list` lists inboxes and aliases for the signed-in user.
- `email_sender_approve` verifies an outbound sender identity or allowlists an
  inbound sender/domain for an inbox.
- `email_sender_revoke` disables an allow rule.
- `email_policy_get` inspects effective sender policy.
- `email_send` sends outbound mail from a verified sender identity.
- `email_reply` replies to a stored inbound message.
- `email_message_list` lists stored sent, accepted, quarantined, or failed
  messages.
- `email_message_get` returns parsed bodies, headers, thread metadata, and
  attachment metadata.

## Safety model

- Unknown inbound senders are quarantined.
- Display names are not trusted. Kody stores envelope sender, parsed `From`, and
  authentication headers separately.
- Outbound sending requires a verified sender identity.
- Inbound package handlers are intentionally disabled in this first slice. Mail
  is stored and audited only.
- Attachments are metadata-only for now; raw MIME for small messages is stored so
  the first pass can be tested locally.

## Local inbound testing

Run the worker locally, create an inbox alias, then post raw MIME to Wrangler's
email test endpoint:

```sh
curl --request POST \
  'http://localhost:8787/cdn-cgi/handler/email?from=sender@example.com&to=alias@example.com' \
  --data-raw 'From: Sender <sender@example.com>
To: Alias <alias@example.com>
Subject: Hello
Message-ID: <hello@example.com>

Hello from local email routing.'
```

Then inspect the message with `email_message_list` and `email_message_get`.
