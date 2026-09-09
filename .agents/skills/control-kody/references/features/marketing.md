# Public marketing pages

Public homepage (session-aware CTAs), pricing, FAQ, support, legal, docs, blog,
Discord invite.

## How to get there

`/`, `/pricing`, `/faq`, `/support`, `/privacy`, `/terms`, `/docs`,
`/docs/:slug`, `/docs/connect`, `/llms.txt`, `/blog`, `/blog/:slug`, `/discord`.
Legacy `/guides*` URLs 308 to `/docs*`. Intra-docs navigation (doc to doc, or a
doc to `/docs` / `/docs/connect`) is an instant shell swap — no page
view-transition — so the sidebar does not re-animate.

## Drive it

```bash
node tools/control-kody.ts health --origin https://kody.codes
node tools/control-kody.ts request GET /docs.json --skip-login --origin https://kody.codes
```

Anonymous HTML on `/` and several marketing routes is short-CDN-cached. Weekly
site-perf owns landing budgets. `/?youtubeId=<id>` opens the site-wide
allowlisted YouTube overlay on those routes; unknown or disallowed ids do not
open the player. Enabled site banners can appear in the first HTML.

## APIs

- `GET /docs.json`
- `GET /blog.json`
- `GET /discord.json`
