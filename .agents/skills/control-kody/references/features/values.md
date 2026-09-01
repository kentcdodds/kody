# Values

Named user values (locale and similar knobs).

## How to get there

`/account/values` → `/account/values/new` → `/account/values/:valueId`.

## Drive it

```bash
node tools/control-kody.ts request \
  POST /account/values.json \
  --body '{"action":"save","name":"locale","value":"en-US"}'
```

## APIs

- `GET|POST /account/values.json`
