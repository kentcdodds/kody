# Community listings and profiles

Public catalog and owner-scoped package URLs. Public and private packages share
the same `/@username/:kodyId` surface; visibility is the only gate.

## How to get there

`/community` → `/@username/kody-id`. Human share URL: `/@username/kody-id`
(never construct `/community/{listing_id}` for people). Files:
`/@username/kody-id/tree/:ref` (`:ref` is the repo default-branch name, a SHA,
or another branch — leftover `/files` and `HEAD` 301 there). Owner settings:
`/@username/kody-id/settings`. Profile: `/@username`.

## Drive it

```bash
node tools/control-kody.ts request GET /community.json --skip-login
```

## APIs

- `GET /community.json`
- `GET /community/:listingId.json`
- `GET /profiles/:username.json`
- `GET /profiles/:username/packages/:kodyId.json`
- `GET /profiles/:username/packages/:kodyId/files.json`
- `POST /community/:listingId/{report,feature,install}.json`
- `POST /community/:listingId/trust.json` returns 410 (no trusted-listing mark)

## Gotchas

- Profiles are public catalogs (packages, ratings, forks). There is no follow
  graph, bookmark-star, or social timeline.
- Files and tree URLs are public read for listed packages and owner-only for
  private ones.
- Package settings 404 for anyone who is not the owner.
