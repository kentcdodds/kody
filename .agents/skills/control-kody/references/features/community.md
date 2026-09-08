# Community listings and profiles

Public catalog and owner-scoped package URLs. Public and private packages share
the same `/@username/:kodyId` surface; visibility is the only gate.

## How to get there

`/community` → `/@username/kody-id`. Human share URL: `/@username/kody-id`
(never construct `/community/{listing_id}` for people). Files:
`/@username/kody-id/tree/:ref` (`:ref` is the repo default-branch name, a SHA,
or another branch — leftover `/files` and `HEAD` 301 there). Media in that tree
previews from `/@username/kody-id/raw/:ref/…`. Owner settings:
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
- Files, tree, and raw media URLs are public read for listed packages and
  owner-only for private ones. `/raw/` only serves allowlisted sniffed media
  (never HTML or JS).
- Package settings 404 for anyone who is not the owner.
- Official `@kody/*` listings skip the install confirm; third-party listings ask
  once (`acknowledged: true` or the install endpoint responds `409`).
- Fork pills are **Fork outdated** when the listing pin is not an ancestor of
  the fork tip, or **Fork ahead** when that pin is already in the fork history
  (website UI only). SHA inequality alone is not enough. That is separate from
  **HEAD ahead of published** on the package Code tab.
