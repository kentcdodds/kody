# YouTube watch overlay

Site-wide `/?youtubeId=<id>` player for allowlisted YouTube videos. Banners can
point at it by storing that relative href. Absolute YouTube watch URLs on a
banner stay external and do not get rewritten to `/?youtubeId=`.

## Surfaces

- **Watch URL**: `/?youtubeId=<11-character-id>` on any app path
  (`/blog?youtubeId=` also works). Unknown or disallowed ids do not open the
  player.
- **Homepage hero**: `/` two-column player + video chooser
  (`landing-hero-video.tsx`). The chooser list and order come from the unlisted
  playlist `landingHeroSourcePlaylistId` (`PLBPBUA8boGLA`), loaded at request
  time and KV-cached with SWR. Embeds still pass the public catalog playlist
  `landingHeroDemoPlaylistId` (`PLXa53KPj2nlE`) so end-of-video recommendations
  stay in that larger set. Chooser ids are allowlisted when thumbs or
  `?youtubeId=` load playlists, so `/youtube-thumb/:id` works for those videos
  without a banner.
- **Thumbnail proxy**: `GET /youtube-thumb/:videoId` (404 unless allowlisted).
  Fetches `maxresdefault.jpg` first (1280×720), then `sddefault.jpg`, then
  `hqdefault.jpg` when a higher quality is missing.
- **Admin helper**: `/admin/banners` paste a watch URL to fill `/?youtubeId=` +
  the first-party thumb path

The overlay player is a first-party `<dialog>` with a poster + play control.
Play swaps in `https://www.youtube-nocookie.com/embed/<id>?autoplay=1`. Closing
strips the `youtubeId` query param. CSP allows that embed host in `frame-src`
only; `img-src` stays first-party. The homepage hero uses the same lite player
outside the overlay.

## Allowlist

A video id is allowed when it appears in any of:

1. The latest items from `YOUTUBE_ALLOWED_PLAYLIST_IDS` (YouTube playlist Atom
   feed, typically ~15 items per playlist, cached about an hour)
2. `YOUTUBE_ALLOWED_VIDEO_IDS` (comma-separated extra ids)
3. The look-preview sample id (`youtubeWatchSampleVideoId`) so
   `?siteBannerLook=` thumbs and Watch CTAs work without an enabled banner
4. Homepage hero chooser ids from `landingHeroSourcePlaylistId` so `/` posters
   and `/youtube-thumb/:id` thumbs work without `?youtubeId=` or an enabled
   banner. That fetch shares the home loader's KV SWR cache.
5. Enabled banner `ctaHref`, `secondaryHref`, or `imageUrl` values that parse as
   a YouTube video (`/?youtubeId=`, watch/embed/short URLs, or
   `/youtube-thumb/<id>`). Absolute `https://kody.codes/?youtubeId=` is not
   parsed — admin and banners store the relative `/?youtubeId=` form.
   Third-party hosts are never treated as a YouTube id, even when they carry
   `?v=` or `?youtubeId=`.

The overlay follows the live `youtubeId` search param only. Closing strips that
param; it does not fall back to SSR loader data, so the dialog stays closed
across client navigations.

Unset playlist env means no overlay playlist fetch (tests stay offline). `none`
disables overlay playlists explicitly. Production and preview set Kent's public
overlay playlist id in `packages/worker/wrangler.jsonc` so shared `/?youtubeId=`
links work without a banner. The Atom feed is not the full catalog and is not
the homepage chooser source.

Failed playlist fetches fail open: env extra ids and banner hrefs still work. A
failed homepage playlist fetch fails open to an empty chooser.

SSR documents other than `/` without `?youtubeId=` skip both the overlay Atom
fetch and the homepage hero playlist fetch. They still merge env extras, the
sample id, and enabled-banner hrefs (from the same `listEnabledSiteBanners` read
as the site-banner loader). Home starts that shared banner read next to auth so
signed-in `/` (always `no-store`) does not wait for banners only after those
finish. `?youtubeId=` HTML and `/youtube-thumb/:videoId` still load playlists
(including hero chooser ids). Shared watch links are full document loads, so
they still resolve playlist ids.

Homepage `/` always loads the chooser playlist for SSR (and
`GET /landing-hero-videos.json` for client navigations), even when the request
has no `youtubeId`. That path prefers an optional origin-only
`YOUTUBE_DATA_API_KEY` (`playlistItems`, playlist order) and falls back to
YouTube's public Innertube browse endpoint so local and preview work without a
key.

## Code

- Parse / thumb rewrite: `packages/worker/universal/youtube-watch.ts`
- Playlist order (Data API + Innertube):
  `packages/worker/universal/youtube-playlist.ts`
- Homepage hero load + KV SWR: `packages/worker/src/app/landing-hero-videos.ts`
- Allowlist: `packages/worker/src/app/youtube-watch-allowlist.ts`
- SSR snapshot: `packages/worker/src/app/youtube-watch-ssr.ts`
- Thumb proxy: `packages/worker/src/app/handlers/youtube-thumb.ts`
- Overlay: `packages/worker/client/youtube-watch-overlay.tsx`
- Homepage hero player: `packages/worker/client/routes/landing-hero-video.tsx`
  and `packages/worker/universal/landing-hero-copy.ts`
