# Billing and usage

Plan, checkout, portal, and entitlement usage.

## How to get there

`/account/billing` (success `/account/billing/success`, portal
`/account/billing/portal`) and `/account/usage`.

## Drive it

```bash
node tools/control-kody.ts request GET /account/billing.json
node tools/control-kody.ts request GET /account/usage.json
```

Do not complete a real Stripe checkout from a Cloud Agent.

## APIs

- `GET /account/billing.json`
- `POST /account/billing/checkout.json`
- `POST /account/billing/cancellation-feedback.json`
- `GET /account/usage.json`
