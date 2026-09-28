# Billing, credits, and usage

Plan, checkout, portal, prepaid credits, and entitlement usage.

## How to get there

`/account/billing` (success `/account/billing/success`, portal
`/account/billing/portal`) and `/account/usage` (credits are its `#credits`
section). `/account/credits` is only a redirect to `/account/usage#credits` that
keeps its query. Billing also shows the signed-in user's referral share link and
reward status.

## Drive it

```bash
node tools/control-kody.ts request GET /account/billing.json
node tools/control-kody.ts request GET /account/usage.json
```

Do not complete a real Stripe checkout or credit top-up from a Cloud Agent.
Checkout sells only Pro ($12/month or $120/year). Retired Standard and $49 Pro
subscribers keep their plan and see a prorated **Switch to Pro** through the
Stripe portal. Deleting an account refunds unused paid subscription time
automatically.

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
Grant credits to a test account from `/admin/users/:stableUserId` (admin only)
instead of paying.

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
paid invoice from this environment.

## APIs

- `GET /account/billing.json`
- `POST /account/billing/checkout.json`
- `POST /account/billing/cancellation-feedback.json`
- `POST /account/credits/top-up.json`
- `POST /account/credits/settings.json`
- `GET /account/usage.json`
