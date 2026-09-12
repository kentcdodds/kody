# Public marketing pages

Public homepage (session-aware CTAs), pricing, FAQ, support, legal, docs, blog,
Discord invite.

## How to get there

`/`, `/pricing`, `/faq`, `/support`, `/privacy`, `/terms`, `/docs`,
`/docs/:slug`, `/docs/connect`, `/llms.txt`, `/blog`, `/blog/:slug`, `/discord`.
Legacy `/guides*` URLs 308 to `/docs*`. Intra-docs navigation (doc to doc, or a
doc to `/docs` / `/docs/connect`) is an instant shell swap — no page
view-transition — so the sidebar does not re-animate. How Kody works (and other
interactive walkthroughs) stay in the article column; they do not break out over
the nav. The docs shell opts out of overflow anchoring so replacing the article
does not bump the rail. After hydrate it independently prefetches every sidebar
href (one loader request per slug, including `/docs/connect`) so a click adopts
a warm payload instead of waiting on a cold fetch.

## Drive it

```bash
node tools/control-kody.ts health --origin https://kody.codes
node tools/control-kody.ts request GET /docs.json --skip-login --origin https://kody.codes
```

Anonymous HTML on `/` and several marketing routes is short-CDN-cached. Weekly
site-perf owns landing budgets. The `/` hero is a two-column layout: headline
plus signup CTAs (anonymous sessions) beside a first-party YouTube light player
with a horizontal video chooser; the lantern/agent orbit sits below that row.
Signed-in visitors still see the player and chooser. Chooser membership and
order come from the unlisted playlist `PLBPBUA8boGLA`. Client navigations load
`GET /landing-hero-videos.json`. Embeds still include the public catalog
playlist. Chooser ids are on the YouTube allowlist for `/youtube-thumb` without
a banner. `/?youtubeId=<id>` opens the site-wide allowlisted YouTube overlay on
those routes; unknown or disallowed ids do not open the player. Enabled site
banners can appear in the first HTML.

## APIs

- `GET /docs.json`
- `GET /blog.json`
- `GET /discord.json`
- `GET /landing-hero-videos.json`
