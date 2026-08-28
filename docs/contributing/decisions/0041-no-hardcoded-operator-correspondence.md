# 0041 — No hardcoded operator correspondence when an admin topic exists

- **Status:** accepted
- **Date:** 2026-08-28

## Context

Kody already fans admin-only package subscription topics for operator facts
(`user.created`, `fleet.entitlement.crossed`, `user.email_verification.failed`).
Several hourly and delivery-queue pings still emailed every admin account
through the transactional Cloudflare sender (`kody@<apex>`) in parallel. Dual
paths meant two inboxes for the same fact, and a new ops ping tempted a new
hardcoded mail plus a one-topic package.

[0036](./0036-platform-packages-fork-only.md) already refuses official `@kody/*`
packages that person accounts would run. Admin notify is Kent's saved package,
not a platform product.

## Decision

The platform owns the fact and the event. Packages own the reaction.

- When an admin-only topic exists (or is the right shape for a new operator
  ping), emit that topic. Do not also send hardcoded mail to the admin roster.
- Do not add an official `@kody/*` admin-notify package. One operator-owned
  package may subscribe to every important admin topic.
- Keep hardcoded mail only when Kody is talking to the account owner (verify
  link, password reset, email-change confirm, user entitlement warnings).

Silence if the notifier package is broken is acceptable: the fact still lives on
the user row, `/admin/users`, or `/admin/insights`.

## Consequences

New operator pings are another admin topic plus a subscription on the existing
notifier, not a new Cloudflare mail helper and not a new one-topic package.
Account-owner transactional mail stays on the platform sender.

Revisit only if operators need a guaranteed platform page that cannot depend on
a saved package (for example a legal or uptime obligation that must fire even
when no admin package is published).
