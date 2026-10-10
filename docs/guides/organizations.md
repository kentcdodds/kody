---
id: organizations
title: Organizations
summary:
  Personal vs team orgs, permanent slugs, free-org limits, and where seats and
  resource ceilings apply.
category: platform
audience: agents
---

# Organizations

Every signed-in person has a **personal** (signup) organization. You can also
create **team** organizations. Resources (packages, secrets, jobs, …) belong to
one org. Handles are permanent: `@slug` does not rename.

## Personal vs team

|                    | Personal                                              | Team                                                                                                                                              |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Created            | At signup (slug = username)                           | `orgCreate` or Create organization                                                                                                                |
| Members / teams    | No — create a team org to invite people or group them | Yes                                                                                                                                               |
| Package grants     | `accessGrant` / grant invites                         | Same, plus the Grants web page                                                                                                                    |
| Resource web pages | Secrets, jobs, packages, connections, …               | Secrets and jobs (and more org-keyed pages); packages and connections still key on the person and 404 on a team URL until listing follows the org |

Switch orgs in the header, or pick the org at MCP consent. One connection binds
one org.

## Free team org limits

A new team org starts on the **same Free plan** as a personal org
([/pricing](/pricing)). There is no separate free-team SKU.

| Limit                                   | Free                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Free orgs you **own** (personal counts) | **2** — so one free team org beside personal                                              |
| Seats                                   | No seat charge on Free. Paid Pro seats are Owners + Members only ($12/seat/mo or $120/yr) |
| Saved packages                          | 10                                                                                        |
| Repos                                   | 20                                                                                        |
| Scheduled jobs                          | 5 (fastest interval 15 minutes)                                                           |
| Execute / day · week                    | 150 · 400                                                                                 |
| Outbound fetches / day · week           | 1,000 · 2,500                                                                             |
| Job runs / day                          | 500                                                                                       |
| Automation invocations / day            | 1,000                                                                                     |
| Secrets                                 | 25                                                                                        |
| Storage                                 | 16 MiB                                                                                    |
| Concurrent workflows                    | 1                                                                                         |
| Active repo sessions                    | 5                                                                                         |

Credits: Free has no prepaid debit wallet. New accounts get a $5 welcome grant
held until the account is **credit-eligible Pro** (purchasable Pro subscription,
or admin credit eligibility on an effective Pro plan — not every paid price is
eligible). Until then the balance is held and not spent.

Example: Ada owns `@ada` (personal, Free) and creates `@ada-work` (team, Free).
That uses both free-org slots. A third free org she tries to own is refused
until one is paid or deleted.

## Paid seats

When an org is Pro, each live Owner and Member is a seat. Billing-only members
and outside collaborators are not seats. See
[Share a package](/docs/package-sharing) for grants vs membership.
