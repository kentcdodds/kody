# YouTube watch overlay

Site-wide `/?youtubeId=<id>` player for allowlisted YouTube videos. Banners can
point at it; the overlay is not a hardcoded launch-video banner.

## Surfaces

- **Watch URL**: `/?youtubeId=<11-character-id>` on any app path
  (`/blog?youtubeId=` also works). Unknown or disallowed ids do not open the
  player.
- **Thumbnail proxy**: `GET /youtube-thumb/:videoId` (404 unless allowlisted)
- **Admin helper**: `/admin/banners` paste a watch URL to fill `/?youtubeId=` +
  the first-party thumb path

The player is a first-party `<dialog>` with a poster + play control. Play swaps
in `https://www.youtube-nocookie.com/embed/<id>?autoplay=1`. Closing strips the
`youtubeId` query param. CSP allows that embed host in `frame-src` only;
`img-src` stays first-party.

## Allowlist

A video id is allowed when it appears in any of:

1. The latest items from `YOUTUBE_ALLOWED_PLAYLIST_IDS` (YouTube playlist Atom
   feed, typically ~15 items per playlist, cached about an hour)
2. `YOUTUBE_ALLOWED_VIDEO_IDS` (comma-separated extra ids)
3. The look-preview sample id (`youtubeWatchSampleVideoId`) so
   `?siteBannerLook=` thumbs and Watch CTAs work without an enabled banner
4. Enabled banner `ctaHref`, `secondaryHref`, or `imageUrl` values that parse as
   a YouTube video (`/?youtubeId=`, watch/embed/short URLs, or
   `/youtube-thumb/<id>`). Absolute `https://kody.codes/?youtubeId=` is not
   parsed — admin and banners store the relative `/?youtubeId=` form.
   Third-party hosts are never treated as a YouTube id, even when they carry
   `?v=` or `?youtubeId=`.

The overlay follows the live `youtubeId` search param only. Closing strips that
param; it does not fall back to SSR loader data, so the dialog stays closed
across client navigations.

Unset playlist env means no playlist fetch (tests stay offline). `none` disables
playlists explicitly. Production and preview set Kent's public playlist id in
`packages/worker/wrangler.jsonc` so shared `/?youtubeId=` links work without a
banner. The Atom feed is not the full catalog; expand later with the YouTube
Data API if operators need every playlist item.

Failed playlist fetches fail open: env extra ids and banner hrefs still work.

## Code

- Parse / rewrite: `packages/worker/universal/youtube-watch.ts`
- Allowlist: `packages/worker/src/app/youtube-watch-allowlist.ts`
- SSR snapshot: `packages/worker/src/app/youtube-watch-ssr.ts`
- Thumb proxy: `packages/worker/src/app/handlers/youtube-thumb.ts`
- Overlay: `packages/worker/client/youtube-watch-overlay.tsx`
