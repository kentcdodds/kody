# Email primitives

Kody has a storage-first email surface for Cloudflare Email Service and Email
Routing. It can send from verified identities, receive routed mail, and store
parsed messages for later automation.

## Capabilities

Use the MCP `email` domain:

- `email_inbox_create` creates an inbox and routable alias.
- `email_inbox_list` lists inboxes and aliases for the signed-in user.
- `email_sender_identity_verify` verifies an outbound sender identity.
- `email_send` sends outbound mail from a verified sender identity.
- `email_reply` replies to a stored inbound message.
- `email_attachment_get` returns stored attachment bytes by attachment id.
- `email_message_list` lists stored inbound and outbound messages.
- `email_message_get` returns parsed bodies, headers, thread metadata, and
  attachment metadata.

## Safety model

- Any email routed to a configured Kody inbox is stored.
- Unknown aliases are still rejected before storage.
- Display names are not trusted. Kody stores envelope sender, parsed `From`, and
  authentication headers separately.
- Outbound sending requires a verified sender identity.
- Stored inbound mail is the source of truth. If a user wants email automation,
  they can publish a package that subscribes to the stored inbound email topic
  `email.message.received` using normal package subscriptions. This is package
  behavior, not a separate Kody-owned email handler or agent-loop primitive.
- Subscription event payloads are metadata-first. Package handlers receive the
  stored message id and receipt metadata, then use `email_message_get` or
  `email_attachment_get` (or `import { email } from 'kody:runtime'`) when they
  need bodies or attachment bytes.
- Attachments remain metadata-first by default; raw MIME for small messages is
  stored so on-demand attachment lookup can reconstruct bytes locally.

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
