# Onboarding

Three-step wizard after signup: connect an agent, give Kody access (teach
prompts), then connect a second agent from a different ecosystem.

## How to get there

Signed-in visit to `/onboarding`. Step 1 is `/onboarding/step-1` (optional
`:agent`). Step 2 is `/onboarding/step-2`. Step 3 is `/onboarding/step-3`
(optional `:agent`). Leftover `/onboarding/step-2/:service` URLs redirect to
Step 2. Also linked from account.

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
