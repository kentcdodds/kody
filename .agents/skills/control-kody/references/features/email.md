# Email inbox

Per-user stored mail (notify-self, reply).

## How to get there

`/account/email` → `/account/email/:messageId`.

## Drive it

```bash
node tools/control-kody.ts request GET /account/email.json
node tools/control-kody.ts request POST /account/email.json --json '{"action":"delete","message_id":"<id>"}'
```

## APIs

- `GET /account/email.json`
- `POST /account/email.json`
  `{ "action": "classify", "message_id", "classification" }`
- `POST /account/email.json` `{ "action": "delete", "message_id" }`

Delete confirms in the UI with a second click, then returns the inbox list and
updated `usage.stored_messages` count.

## Gotchas

- Preview seed starts empty. Inbound mail is not something a Cloud Agent can
  mint without the email store APIs.
