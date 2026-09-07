# Billing and usage

Plan, checkout, portal, and entitlement usage.

## How to get there

`/account/billing` (success `/account/billing/success`, portal
`/account/billing/portal`) and `/account/usage`. Billing also shows the
signed-in user's referral share link and reward status.

## Drive it

```bash
node tools/control-kody.ts request GET /account/billing.json
node tools/control-kody.ts request GET /account/usage.json
```

Do not complete a real Stripe checkout from a Cloud Agent. Existing subscribers
change plans through the Stripe portal (proration). Deleting an account refunds
unused paid subscription time automatically. `/account/usage` and `usageGet`
include unique Dynamic Worker days and Durable Object rows-read with what-counts
copy. Public-ladder overage uses the list rates on `/pricing`. Referral share
links set a one-week last-wins `kody_ref` cookie; signup persists the referrer
then. Referral rewards fire on the referee's first qualifying paid Stripe
invoice (not a trial) after both emails are verified; do not invent a paid
invoice from this environment.

## APIs

- `GET /account/billing.json`
- `POST /account/billing/checkout.json`
- `POST /account/billing/cancellation-feedback.json`
- `GET /account/usage.json`
