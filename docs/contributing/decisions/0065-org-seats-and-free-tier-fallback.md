# 0065 — Org seats, prepaid credits, and free-tier fallback

- **Status:** accepted
- **Date:** 2026-10-09
- **Supersedes:** [0051](./0051-include-credits-stop.md)

## Context

Teams P6 billing treats each organization as the entitlement and wallet
boundary: seats bill Owners and Members on the existing Pro subscription
(quantity = live seat count), prepaid credits cover usage past the monthly
include, and org-level defaults plus per-user budgets cap spend for members and
outside collaborators. Kent settled pricing at $12/mo or $10/mo on yearly seats,
one monthly include per paid org, two free orgs per user, billing emails to
owners plus the billing role, and budgets that apply to outside collaborators.

[ADR 0051](./0051-include-credits-stop.md) chose **include → credits → stop**
for purchasable Pro on personal accounts. Org billing needs the same customer
story for usage past the include, but at **$0 credits** the org should fall back
to **free-tier limits** rather than hard-stopping all usage. Stripe must resolve
org identity on new objects via `kody_org_id`; migrated personal orgs keep
`kody_stable_user_id` in metadata (same id as `orgs.id`).

## Decision

- **Usage path for paid orgs:** **include → credits → free-tier limits** (not
  stop). When prepaid balance is zero, meters and rates behave like the free
  plan caps instead of throwing overage errors or burning unmetered compute.
- **Seats:** The existing Pro subscription with **quantity = live Owners +
  Members**. Billing-only and outside collaborators are **not** seats.
- **Kody-only Stripe mutations:** Billing code may only read-modify
  subscriptions that carry a known Kody price (purchasable Pro or retired
  Standard/Pro ids) or Kody metadata (`kody_org_id`, `kody_stable_user_id`,
  `kody_plan`). Shared-account products such as GratiText Premium must never be
  listed as "the" Kody subscription for seat sync, portal plan changes, or
  account-deletion cancels.
- **No P6 price migration:** Existing subscribers inherit their current
  subscription exactly, including retired prices. P6 does not move anyone off a
  retired price and does not change quantity on retired-price subscriptions.
  Seat quantity sync applies only to purchasable Pro (current seat) prices. Any
  retired-plan price migration is a separate customer-facing decision.
- **Free org cap:** Each user may own at most **two** orgs on `plan = free`.
  Creating or accepting ownership of another free org requires upgrading or
  deleting an existing free org.
- **Stripe metadata:** New checkout, subscription, and customer objects set
  `kody_org_id`. During personal-org dual-resolve, also set
  `kody_stable_user_id` to the same org id; migrated orgs continue to rely on
  `kody_stable_user_id` until cleanup drops the legacy key.
- **Billing notifications:** Email owners and users with the billing membership
  role for invoice and payment events.

## Consequences

- Entitlement and metering code must branch on org plan, wallet balance, and
  seat count; free-tier fallback replaces the empty-wallet hard stop from 0051
  for org-scoped billing.
- Seat quantity sync must ignore billing-only and collaborator memberships.
- Seat sync, checkout portal updates, and account-deletion cancels must use
  {@link selectKodyPlanRetainingSubscriptions} (or equivalent); status-only
  filtering is unsafe on the shared Stripe account.
- Webhooks and checkout success handlers resolve org id from metadata
  (`kody_org_id` first, then `kody_stable_user_id`).
- Customer copy must not use em dashes; describe fallback as free-tier limits,
  not as unlocking or lifting tiers.
