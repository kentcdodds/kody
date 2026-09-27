# 0051: Pro bills include → credits → stop (no fund-to-unlock, no free past-include burn)

- **Status:** accepted
- **Date:** 2026-09-27

## Context

Prepaid credits v1 ([#2634](https://github.com/kentcdodds/kody/pull/2634)) sold
purchasable Pro as "add credits to lift rate caps": a positive balance switched
on 50× rates, and an empty wallet kept running past the monthly Worker compute
and Rows read include with nothing to charge. Earlier on the same day, a
hard-stop at $0 was considered and rejected. Purchasable Pro also carries Max
stock and concurrency whether the wallet is empty or funded
([#2644](https://github.com/kentcdodds/kody/pull/2644)), so an empty-wallet
account could run past the include at Max concurrency. Kent's customer story
(2026-09-27 evening) is: Free is hard-capped; Pro is a seat plus a monthly
include; need more, add credits until they are gone; small print, usage past the
include is charged from credits, up to about 50× Pro's included limits.

## Decision

Purchasable Pro has one billing path: **include → credits → stop**. At
$0, usage
past the include stops. For the monthly meters, `consumeDailyEntitlement` throws
`ComputeOverageLimitError` for execute, job runs, and automation invocations,
and hosted package apps (HTTP and realtime hooks) take the same stop.
For rates, the daily and weekly caps stop at the include. There is no free
past-include burn and no customer-facing "balance above $0
unlocks higher rates". The 50× figure is a ceiling on how far credits go, not a
tier. Customer copy never says unlock, lift, or Max. Free and wallet-less Pro
(retired, gift, referral, manual) keep their existing tables and hard caps.

This supersedes the earlier same-day "no empty-wallet hard-stop" call.

## Consequences

- Rates still gate on a positive balance internally, because that gate is the
  include → credits → stop path applied to daily caps. Dropping it and relying
  only on the monthly stop was rejected: CPU and Durable Object duration are not
  debited, so an empty wallet at 50× rates could burn unmetered compute while
  staying under its Worker compute include.
- The stop reads hourly `usage_rollups`, so it can trail usage by about an hour.
  A later top-up forgives that overshoot instead of charging it.
- A small positive balance can keep 50× rates while monthly usage stays within
  the include. Credits only move when Worker compute or Rows read go past the
  include.
- **Revisit if** execute calls or CPU become debit meters (then rates could
  follow balance directly), or if hour-scale overshoot on empty wallets shows up
  as real cost in fleet data.
