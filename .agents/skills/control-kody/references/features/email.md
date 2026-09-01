# Email inbox

Per-user stored mail (notify-self, reply).

## How to get there

`/account/email` → `/account/email/:messageId`.

## Drive it

```bash
node tools/control-kody.ts request GET /account/email.json
```

## APIs

- `GET /account/email.json`

## Gotchas

- Preview seed starts empty. Inbound mail is not something a Cloud Agent can
  mint without the email store APIs.
