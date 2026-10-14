# 0074: One email address per org; admins see all mail, packages only through per-sender enablements

- **Status:** accepted
- **Date:** 2026-10-13

## Context

Inbound mail resolved a username to a person's personal org and ran non-member
mail through an inbox-owner enablement fallback
([0068](./0068-credentials-own-placement-scoped-clients.md)). Team orgs already
had an Email page keyed by org id ([0063](./0063-teams-expand-orgs.md)), but
inbound never wrote that mailbox. Packages needed a way to run for specific
senders without a blanket switch, while Owner/Admin still needed to see every
accepted message ([0062](./0062-one-access-check.md)).

## Decision

Each org has one address `{slug}@inbox.kody.codes` (personal orgs keep
`{username}@`). Slugs and usernames share one namespace. Plus-tags resolve to
the base address; the full tagged recipient stays on `to_addresses`. There are
no package-specific plus aliases.

All accepted mail (including quarantined and unenabled senders) is stored in the
org's Mailbox DO keyed by org id ([0060](./0060-owner-and-person-ids.md),
[0061](./0061-one-request-context.md)). Owner/Admin see it through an org
`email:*` permission in the single access check. Packages run only through
per-sender enablement rows (`sender_kind` / `sender_value` on `enablements`),
approved via the existing proposal flow
([0068](./0068-credentials-own-placement-scoped-clients.md) /
[0067](./0067-cross-org-grants-replace-shares-and-platform-accounts.md)). There
is no direct enable API and no blanket switch. The inbox-owner fallback is
retired: unmatched authenticated senders stay in the admin inbox only.

Evaluation order is fixed: route → org gates → block rule (SMTP reject) → store
and classify → sender classification (unverified runs nothing) → match
enablements and run as the enabler.

## Consequences

Personal `{username}@` keeps working. Live personal-org email subscription
enablements are tagged `sender_kind = any_authenticated` (migrated) so existing
subscriptions keep firing; the UI may offer narrowing. Team orgs get no migrated
rows and their own sender-rule set keyed by org id. Sender rules never create a
package match. Address/domain/`any_authenticated` rows match only when From
authenticates by DMARC pass or aligned SPF, never DKIM-only. Member rows also
require `package:execute` at run time.

**Revisit-if:** product needs package plus-aliases, a true blanket org switch
without per-sender rows, or dropping the migrated catch-all without a narrowing
path.
