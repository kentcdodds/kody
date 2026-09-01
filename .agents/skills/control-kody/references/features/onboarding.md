# Onboarding

First-run checklist after signup.

## How to get there

Signed-in visit to `/onboarding`. Also linked from account.

## Drive it

```bash
node tools/control-kody.ts preview -- \
  --request 'GET /onboarding.json' \
  --check /onboarding \
  --request 'POST /onboarding/checklist-dismiss.json {}' \
  --request 'GET /onboarding.json'
```

## APIs

- `GET /onboarding.json`
- `POST /onboarding/checklist-dismiss.json`

## Gotchas

- Local wrangler reload loops have blocked real `/onboarding` screenshots. Use
  `control-kody doctor` and `dev:ensure` before a UI pass.
