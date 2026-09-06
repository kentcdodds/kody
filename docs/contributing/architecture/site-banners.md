# Site banners

Operator-owned site announcement banners. Admins create, edit, enable, and
disable banners without a code deploy. The origin Worker resolves at most one
banner per request during SSR and paints it in the first HTML so the strip does
not jump after hydration.

## Surfaces

- **Admin UI**: `/admin/banners` (+ `/admin/banners.json` API)
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
   matches, show the launch-video sample.

Page targeting is `all` or `routes` with globs: `*` is one path segment, `**` is
a suffix. Audience is `everyone`, `logged_out`, `logged_in`, `users` (stable
user ids), or `plans` (`free` / `standard` / `pro` / `max`).

## Dismiss and cache

Dismissible banners persist forever: signed-in users write
`site_banner_dismissals`; everyone also gets the HttpOnly
`kody_site_banner_dismiss` cookie. A dismiss cookie forces `no-store` on
otherwise-cacheable anonymous marketing HTML so a dismissed visitor does not
receive a cached document that still contains the banner.

## Looks

`look` is a first-class field: `strip` (slim top bar), `promo` (richer strip
with a play badge), or `card` (inset announcement). Each look reserves a
`minHeight` in the first paint. Do not lock a launch-video look until an
operator picks one; preview all three from the admin page or the query params
above.

## Code

- Types and matching: `packages/worker/universal/site-banners.ts`
- D1 service: `packages/worker/src/site-banners/service.ts`
- SSR load: `packages/worker/src/app/site-banner-ssr.ts`
- Client render: `packages/worker/client/site-banner.tsx`
- Admin UI: `packages/worker/client/routes/admin-banners.tsx`
