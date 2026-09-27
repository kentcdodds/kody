# Billing, credits, and usage

Plan, checkout, portal, prepaid credits, and entitlement usage.

## How to get there

`/account/billing` (success `/account/billing/success`, portal
`/account/billing/portal`), `/account/credits`, and `/account/usage`. Billing
also shows the signed-in user's referral share link and reward status.

## Drive it

```bash
node tools/control-kody.ts request GET /account/billing.json
node tools/control-kody.ts request GET /account/credits.json
node tools/control-kody.ts request GET /account/usage.json
```

Do not complete a real Stripe checkout or credit top-up from a Cloud Agent.
Checkout sells only Pro ($12/month or $120/year). Retired Standard and $49 Pro
subscribers keep their plan and see a prorated **Switch to Pro** through the
Stripe portal. Deleting an account refunds unused paid subscription time
automatically.

`/account/credits` is the prepaid wallet for the purchasable Pro: balance, packs
($10 / $25 / $50) or a custom amount, auto-refill (threshold at least $5,
amount, and monthly cap), notification checkboxes, the limits a balance above $0
raises, the two debit rates, and recent ledger entries. Other plans see a single
switch-to-Pro prompt. Usage above the monthly include debits a funded wallet;
nobody is invoiced for overage. Grant credits to a test account from
`/admin/users/:stableUserId` (admin only) instead of paying.

`/account/usage` and `usageGet` include unique Dynamic Worker days and Durable
Object rows-read with what-counts copy and a credits status per meter (add
credits, switch to Pro, or debiting credits — all link to `/account/credits`).
Public-ladder execute and outbound fetches show today and this UTC week
(Monday–Sunday); whichever window hits first blocks. The usage warnings panel
titles **Limit reached** when a hard daily/weekly/stock cap is at 100%, and its
link points at `/account/credits`. Referral share links set a one-week last-wins
`kody_ref` cookie; signup persists the referrer then. Referral rewards fire on
the referee's first qualifying paid Stripe invoice (not a trial) after both
emails are verified; do not invent a paid invoice from this environment.

## APIs

- `GET /account/billing.json`
- `POST /account/billing/checkout.json`
- `POST /account/billing/cancellation-feedback.json`
- `GET /account/credits.json`
- `POST /account/credits/top-up.json`
- `POST /account/credits/settings.json`
- `GET /account/usage.json`
