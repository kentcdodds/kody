# Public marketing pages

Logged-out landing, pricing, FAQ, support, legal, guides, blog, Discord invite.

## How to get there

`/`, `/pricing`, `/faq`, `/support`, `/privacy`, `/terms`, `/guides`,
`/guides/:slug`, `/guides/connect`, `/blog`, `/blog/:slug`, `/discord`.

## Drive it

```bash
node tools/control-kody.ts health --origin https://kody.codes
node tools/control-kody.ts request GET /guides.json --skip-login --origin https://kody.codes
```

Anonymous HTML on `/` and several marketing routes is short-CDN-cached. Weekly
site-perf owns landing budgets.

## APIs

- `GET /guides.json`
- `GET /blog.json`
- `GET /discord.json`
