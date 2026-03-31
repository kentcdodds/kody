# Secret Host Approval Policy

This document describes the required policy for outbound requests that use saved
secrets.

## Rule

Allowed outbound hosts for a secret and allowed capabilities for direct
capability-input secret resolution are privileged policy, not normal secret
metadata.

Those policies must not be created, widened, or modified by:

- MCP tools
- execute-time sandboxed code
- generated UI code
- capability handlers that serve agent-driven secret creation or update flows

Allowed outbound hosts and allowed capabilities may only be changed through the
authenticated account admin UI.

In this repo, that means the user must approve host access through the account
secrets experience, such as `/account/secrets` and the focused approval route at
`/account/secrets/approve`.

## What agents should assume

Agents should assume all newly created secrets start with an empty host
allowlist unless the user has already approved one or more hosts in the admin
UI.

Saving or updating a secret value does not authorize sending that secret to any
host or passing it into any capability.

If an outbound request uses a placeholder such as `{{secret:name}}` and the
target host is not already approved for that secret, the correct behavior is:

1. Stop retrying.
2. Show the user the approval link from the error.
3. Ask the user whether they want to approve that host in the admin UI.
4. Retry only after the user approves it.

## What agents must not do

Do not design or document any MCP capability, generated UI helper, or client
library that allows agent-controlled writes to a secret's allowed hosts or
allowed capabilities.

Specifically, do not:

- add `allowed_hosts` or equivalent fields to MCP-facing secret create/update
  inputs
- add `allowed_capabilities` or equivalent fields to MCP-facing secret
  create/update inputs
- imply that a generated UI can self-authorize a host just because it can save a
  secret
- imply that execute-time capability calls can widen which capabilities may
  consume a secret
- imply that execute-time code can widen egress permissions
- treat host approval or capability allowlists as ordinary secret metadata
  editing

If a workflow would be smoother by auto-approving a host, the fix should be
better guidance, helper APIs, or UX around the approval flow, not a new write
path that bypasses the admin UI.

## Guidance for capability authors

When writing capability descriptions or agent-facing docs:

- say explicitly that secret save/update does not grant outbound use
- say explicitly that secret save/update does not grant capability access
- say explicitly that only the authenticated account admin UI can approve hosts
- say explicitly that only the authenticated account admin UI can restrict which
  capabilities may consume a secret directly
- say explicitly that secret-bearing capability inputs are write-only from the
  model's perspective and must not be echoed in execute results or logs
- tell agents to inspect secret metadata before making a secret-bearing request
- tell agents to surface the approval link and stop on deny

This policy is especially important in:

- secret create/update/list capabilities
- capability input fields annotated with `x-kody-secret: true`
- execute-time fetch documentation
- generated UI runtime documentation
- OAuth and other hosted callback examples

## Capability input placeholders

Some capabilities may explicitly opt specific string input fields into secret
placeholder resolution by using `markSecretInputFields(...)`, which marks those
fields with `x-kody-secret: true` in the JSON Schema.

That feature is for cases where the capability needs the secret value itself,
for example to store credentials on a local connector or pass them into a
device-local action.

If a secret has an allowed-capabilities policy, Kody enforces that allowlist by
capability name before resolving the placeholder for the handler.

Use it narrowly:

- mark only the exact sensitive fields
- prefer it for local persistence or device-side credential handoff
- require an authenticated user, just like fetch-time secret placeholders
- never return or log the resolved plaintext after it crosses an `x-kody-secret`
  capability boundary

Do not treat `x-kody-secret` as a generic replacement for execute-time
`fetch(...)` placeholders.

If a workflow's real security boundary is outbound network use, keep that flow
on the fetch placeholder path so host approval still applies before the request
is sent.

## Guidance for generated UI flows

Generated UIs may:

- collect secret values from the user
- save those values as secrets
- save and read back non-secret values for public configuration
- inspect secret metadata, including current allowed hosts
- inspect secret metadata, including current allowed capabilities
- present approval links returned from blocked requests

Generated UIs may not:

- set allowed hosts directly
- set allowed capabilities directly
- bypass the admin approval route
- silently retry secret-bearing requests after a deny
- use `executeCode(...)` as a general string interpolation mechanism for
  `{{secret:...}}` placeholders

When a generated UI hits a recoverable runtime problem, it should:

1. Show the problem in the UI.
2. Call `sendMessage(...)` when available so the parent chat can help the user.
3. Include the next action the user should take, such as approving a host,
   providing a missing non-secret value, or retrying after a fix.

For OAuth and similar flows, prefer this sequence:

1. Save the client credentials as secrets.
2. Use a hosted saved app as the callback page when helpful.
3. Attempt the token exchange with secret placeholders.
4. If the exchange is blocked on host approval, send the user to the admin UI
   approval page.
5. Retry after approval.
