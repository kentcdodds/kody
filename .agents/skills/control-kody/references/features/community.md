# Community listings and profiles

Public catalog and owner-scoped package URLs.

## How to get there

`/community` → `/community/:listingId`. Human share URL: `/@username/kody-id`
(never construct `/community/{listing_id}` for people). Profile: `/@username`.

## Drive it

```bash
node tools/control-kody.ts request GET /community.json --skip-login
```

## APIs

- `GET /community.json`
- `GET /community/:listingId.json`
- `GET /profiles/:username.json`
- `GET /profiles/:username/packages/:kodyId.json`
- `POST /community/:listingId/{report,feature,install}.json`
- `POST /community/:listingId/trust.json` returns 410 (no trusted-listing mark)

## Gotchas

- Profiles are public catalogs (packages, ratings, forks). There is no follow
  graph, bookmark-star, or social timeline.
- Files and tree URLs are public read for listed packages.
