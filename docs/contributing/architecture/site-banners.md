# Site banners

Operator-owned site announcement banners. Admins create, edit, enable, and
disable banners without a code deploy. The origin Worker resolves at most one
banner per request during SSR and paints it in the first HTML so the strip does
not jump after hydration.

## Surfaces

- **Admin UI**: `/admin/banners` (+ `/admin/banners.json` API). A full-width
  stage shows the live look: title, body, and button labels edit in the chrome.
  CTA/secondary URLs and dismiss sit on a rail under the band. Switch A/B/C to
  restyle before save. Targeting, schedule, YouTube paste, and enable stay in
  the card under the stage.
- **MCP**: `adminBannerList`, `adminBannerSave`, `adminBannerDelete`
  (`requiredRole: 'admin'`)
- **Viewer dismiss**: `POST /site-banner-dismiss.json`
- **Admin look preview** (no enable required):
  `?siteBannerLook=strip|promo|card` and `?siteBannerPreview=<uuid>`

## Resolution

1. Load enabled banners (or all banners when an admin is previewing).
2. Hide on `/login`, `/signup`, `/oauth/authorize`, `/connect/oauth`, and
   `/connect/secrets` unless an admin preview query is present.
3. Filter by schedule, page targeting, audience, and dismissals.
4. Sort by priority (highest wins), then `updatedAt`, then `id`.
5. Show one banner. If an admin passed `siteBannerLook` and nothing else
   matches, show the look-preview sample (not a live/enabled banner).
6. The HTML snapshot only embeds candidates this viewer is eligible for, with
   `audienceUserIds` and actor ids stripped, so anonymous cache cannot leak
   targeted copy or stable user ids.

Page targeting is `all` or `routes` with globs: `*` is one path segment, `**` is
a suffix. Audience is `everyone`, `logged_out`, `logged_in`, `users` (stable
user ids), or `plans` (`free` / `standard` / `pro` / `max`).

## Dismiss and cache

Dismissible banners persist forever: signed-in users write
`site_banner_dismissals`; everyone also gets the HttpOnly
`kody_site_banner_dismiss` cookie. A dismiss cookie forces `no-store` on
otherwise-cacheable anonymous marketing HTML and skips the origin
`caches.default` lookup so a dismissed visitor does not receive a cached
document that still contains the banner.

## Looks

`look` is a first-class field: `strip` (slim top bar), `promo` (richer strip
with optional 16:9 media), or `card` (inset announcement). New drafts default to
`promo`. `strip` and `promo` paint full-bleed chrome; gutters live on the inner
row so the strip spans the viewport. `card` stays inset. Each look reserves a
`minHeight` in the first paint.

## Images and in-site video

Banners can show a first-party image and a CTA. Stored `ctaHref` and
`secondaryHref` values render as stored: an absolute YouTube (or other https)
URL stays off-site, including playlist query params. A stored `/?youtubeId=<id>`
path still opens the on-site overlay. A YouTube watch URL or `/?youtubeId=<id>`
CTA derives `/youtube-thumb/<id>` when `imageUrl` is empty. Raw `i.ytimg.com`
URLs are rewritten to that same-origin path so CSP can keep `img-src`
first-party. The admin form has a paste helper that fills
`ctaHref=/?youtubeId=<id>` and the thumb path when the operator wants the
overlay. Operators create and enable content in D1.

In-site playback is the site-wide `/?youtubeId=` overlay, not a banner-only
player. See [YouTube watch overlay](./youtube-watch.md).

## Code

- Types and matching: `packages/worker/universal/site-banners.ts`
- D1 service: `packages/worker/src/site-banners/service.ts`
- SSR load: `packages/worker/src/app/site-banner-ssr.ts`
- Shared look CSS: `packages/worker/client/site-banner-looks.ts`
- Client render: `packages/worker/client/site-banner.tsx`
- In-place admin editor: `packages/worker/client/site-banner-editor.tsx`
- Admin UI: `packages/worker/client/routes/admin-banners.tsx`
