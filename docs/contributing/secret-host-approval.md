# Secret Host Approval Policy

This document describes the required policy for outbound requests that use saved
secrets.

## Rule

Allowed outbound hosts for a secret are privileged policy, not normal secret
metadata.

Those policies must not be created, widened, or modified by:

- MCP tools
- execute-time sandboxed code
- package app code
- capability handlers that serve agent-driven secret creation or update flows

Allowed outbound hosts may only be changed through the authenticated account
admin UI.

In this repo, that means the user must approve host access through the
authenticated **`/connect/secrets`** page (query params `name` / `names` and
`hosts`). The account secrets editor at `/account/secrets` can still show an
"Allow access" card for older single-host links. Package grants stay on
`/account/secrets/approve`.

## What agents should assume

Agents should assume a secret starts with an empty host allowlist unless the
user has already approved one or more hosts in the admin UI.

Saving or updating a secret value does not authorize sending that secret to any
host.

If an outbound request uses a placeholder such as `{{secret:name}}` and the
target host is not already approved for that secret, the correct behavior is:

1. Stop retrying.
2. Show the user the approval link from the error.
3. Ask the user whether they want to approve that host in the admin UI.
4. Retry only after the user approves it.

The same stop-and-surface rule applies to package secret access denies. When
several secrets or hosts need approval together, prefer the bulk host approval
URL (`/connect/secrets?names=...&hosts=...`) or the bulk package approval URL
(`/account/secrets/approve?package_id=...&names=...`) over one link per secret.
Agents must never auto-approve host or package access.

## What agents must not do

Do not design or document any MCP capability, package app helper, or client
library that allows agent-controlled writes to a secret's allowed hosts.

Specifically, do not:

- add `allowed_hosts` or equivalent fields to MCP-facing secret create/update
  inputs
- imply that a package app can self-authorize a host just because it can save a
  secret
- imply that execute-time code can widen egress permissions
- treat host approval as ordinary secret metadata editing

If a workflow would be smoother by auto-approving a host, the fix should be
better guidance, helper APIs, or UX around the approval flow, not a new write
path that bypasses the admin UI.

## Guidance for capability authors

When writing capability descriptions or agent-facing docs:

- say explicitly that secret save/update does not grant outbound use
- say explicitly that only the authenticated account admin UI can approve hosts
- tell agents to inspect secret metadata before making a secret-bearing request
- tell agents to surface the approval link and stop on deny

This policy is especially important in:

- secret create/update/list capabilities
- execute-time fetch documentation
- package app documentation
- OAuth and other hosted callback examples

## Guidance for package app flows

Package apps may:

- collect secret values from the user
- save those values as secrets
- save and read back non-secret values for public configuration
- inspect secret metadata, including current allowed hosts
- present approval links returned from blocked requests

Package apps may not:

- set allowed hosts directly
- bypass the admin approval route
- silently retry secret-bearing requests after a deny

When a package app hits a recoverable runtime problem, it should:

1. Show the problem in the UI.
2. Include the next action the user should take, such as approving a host,
   providing a missing non-secret value, or retrying after a fix.

For OAuth and similar flows, prefer this sequence:

1. Save the client credentials as secrets.
2. Use a hosted package app as the callback page when helpful.
3. Attempt the token exchange with secret placeholders.
4. If the exchange is blocked on host approval, send the user to the admin UI
   approval page.
5. Retry after approval.
