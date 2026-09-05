# Onboarding

Two-step wizard after signup: connect an agent, then give Kody Access.

## How to get there

Signed-in visit to `/onboarding`. Step 1 is `/onboarding/step-1` (optional
`:agent`). Step 2 is `/onboarding/step-2` (optional `:service`). Also linked
from account.

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

- `/onboarding` screenshots come from the real origin after
  `control-kody doctor` and `dev:ensure`. `dev:ensure` waits for a starting
  leftover instead of killing it mid-reload. Do not dump one onboarding
  component to static HTML.
