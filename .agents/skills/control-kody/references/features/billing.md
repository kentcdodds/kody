# Billing, credits, and usage

Plan, checkout, portal, prepaid credits, and entitlement usage.

## How to get there

`/@:orgSlug/-/billing` (success `/@:orgSlug/-/billing/success`, portal
`/@:orgSlug/-/billing/portal`) and `/account/usage` (credits are its `#credits`
section). Billing belongs to the organization in the URL. Owners and billing
admins subscribe and manage; members get 403 from checkout and the portal. Team
organizations buy one Pro seat per owner and member. `/account/billing` (and its
`/success` and `/portal`) redirects to the signup organization's billing page,
keeping the query. `/account/credits` is only a redirect to
`/account/usage#credits` that keeps its query. Billing also shows the signed-in
user's referral share link and reward status.

## Drive it

```bash
node tools/control-kody.ts request GET /@user-me/-/billing.json
node tools/control-kody.ts request GET /account/usage.json
```

Do not complete a real Stripe checkout or credit top-up from a Cloud Agent.
Preview deploys have no Stripe keys, so checkout answers 409 there. Checkout
sells only Pro ($12/month or $120/year). Promo codes are typed on the Kody
billing page (Stripe Checkout has no code box), apply to new monthly
subscriptions only, and are rejected on annual before any Stripe call. Retired
Standard and $49 Pro subscribers keep their plan and see a prorated **Switch to
Pro** through the Stripe portal. Deleting an account refunds unused paid
subscription time automatically.

The usage page's Credits section is the prepaid wallet for the purchasable Pro:
balance, packs ($10 / $25 /
$50) or a custom amount, auto-refill (threshold at
least $5, amount, and monthly
cap), notification checkboxes, How far credits go, the How credits are charged
rate card (Worker compute and Rows read debit rates), and credit history.
`/account/usage.json` carries it as `credits`. Other plans see a single
switch-to-Pro prompt with no purchase UI; operator plans have no Credits
section. Top-up Stripe returns land on `/account/usage?topup=success`, which
confirms and redirects to `/account/usage?credits=added#credits`. Usage above
the monthly include debits a funded wallet; nobody is invoiced for overage.
Every newly created person account receives a $5 house grant (held until the
account is credit-eligible Pro). Grant extra credits to a test account from
`/admin/users/:stableUserId` (admin only) instead of paying.

Directly under the included-compute period total, **Where it went** ranks
packages by past-include credits (plus one **Ad hoc** row for direct execute and
unattributed debits). Expand a package row for the compute vs Rows read split
and a package link; expand Ad hoc for a cumulative graph. The same period total,
split, and cumulative graph appear on the owner package settings page. Customer
copy never says UWD.

`/account/usage` and `usageGet` lead with activity (code executions, job runs,
workflow runs, package calls). Worker compute and Rows read are an include bar
capped at 100%, with past-include usage as dollars on credits. Free sees those
meters as informational counts; execute caps are the Free limit. Alarms fire
only when the wallet or access is at risk. Public-ladder execute and outbound
fetches show today and this UTC week (Monday–Sunday); whichever window hits
first blocks. The usage warnings panel titles **Limit reached** when a hard
daily/weekly/stock cap is at 100%, and its link points at `#credits`. Referral
share links set a one-week last-wins `kody_ref` cookie; signup persists the
referrer then. Referral rewards fire on the referee's first qualifying paid
Stripe invoice (not a trial) after both emails are verified; do not invent a
paid invoice from this environment. Package credit attribution for the usage
dashboard filter is `usageByPackageGet` (`GET /v1/account/usage/by-package`).

## APIs

- `GET /@:orgSlug/-/billing.json`
- `POST /@:orgSlug/-/billing/checkout.json` (`{ plan, interval, promoCode? }`)
- `POST /account/billing/cancellation-feedback.json`
- `POST /account/credits/top-up.json`
- `POST /account/credits/settings.json`
- `GET /account/usage.json`
- `GET /v1/account/usage/by-package` (`usageByPackageGet`)
