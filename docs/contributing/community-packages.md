# Community packages

Community listings let users on the same deployment share **pinned snapshots**
of published saved packages. Listings are public read; forks stay **inert**
until the forker publishes through a repo session. See
[Community packages (usage)](../use/community-packages.md) for agent-facing
workflows.

## Architecture overview

```
Owner publishes saved package
        │
        ▼
community_publish ──► D1 community_listings row
        │              KV snapshot (pinned files)
        ▼
Public /community pages + community_search / community_get
        │
        ▼
Visitor forks ──► community_fork ──► entity_sources (no saved_packages row)
        │                              cross-scope reference scan
        ▼
repo_open_session → review → fix imports → repo_publish_session
        │
        ▼
Live saved package in forker's account
```

Community search and capabilities live in the **`community`** MCP domain. They
are intentionally **not** merged into the general MCP `search` tool or saved
package vector indexes.

## Storage

### D1 tables

Migration: `packages/worker/migrations/0045-community-listings.sql`

| Table                | Purpose                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `community_listings` | Listing metadata, pinned commit, status (`active` / `delisted`)    |
| `community_forks`    | Fork records linking listing, forker, and inert `source_id`        |
| `community_ratings`  | Per-user ratings (upsert on `listing_id` + `user_id`)              |
| `community_reports`  | Reports with denormalized `listing_name` / `listing_owner_user_id` |
| `community_bans`     | Community-wide bans (publish, fork, rate, report)                  |

`community_listings` enforces one listing per `(owner_user_id, package_id)`.
Admin **delist** sets `status = 'delisted'`, blocks owner re-publish, and blocks
owner unpublish. **Hard delete** (admin report action) removes the listing row,
KV snapshot, and ratings.

Reports survive listing deletion via denormalized listing name and owner on the
report row.

### KV snapshots

Pinned file trees live in `BUNDLE_ARTIFACTS_KV` under:

`community-snapshot:v1:{listingId}`

`packages/worker/src/community/snapshot.ts` reads and writes `CommunitySnapshot`
(`version`, `listingId`, `pinnedCommit`, `files`, optional `communityIconPath`,
`createdAt`). Publish and re-publish overwrite the snapshot; unpublish and hard
delete remove it. Binary icon bytes are omitted from the text-backed `files`
map; the path metadata lets the icon route retrieve bytes from Artifacts.

### Community icon cache

Community listing icons are derived lazily from the listing's **icon commit**:
the owner package's current `entity_sources.published_commit` (falling back to
the listing's pinned commit when the source row is gone). Listing reads join the
entity source, so a plain package publish moves the icon commit forward — and
with it the icon URL — without a community republish. `@epic-web/cachified`
stores a small descriptor in `BUNDLE_ARTIFACTS_KV` under
`derived-cache:v1:community-icon:v1:{listingId}:{commit}`. The processed bytes
live in the private `COMMUNITY_ASSETS` R2 bucket under
`community-icon:v1/{listingId}/{commit}/asset`.

On a descriptor cache miss, the icon service resolves the standardized root
`community-icon.*` path (from the pinned snapshot when serving the pinned
commit, otherwise by probing the Artifacts git repo at the icon commit), reads
the bytes, validates them, and writes the derived asset to R2 before returning
the descriptor. A dangling descriptor is deleted and regenerated once. Packages
without an icon receive a generated fallback. SVG input is rasterized to PNG;
PNG, WebP, and JPEG input remains in its validated source format.

The icon route serves only the current icon commit and the pinned commit; stale
commit URLs 404. Package publish (`finalizePublishedEntitySource`) calls
`refreshCommunityIconForPackagePublish`, which prunes superseded KV/R2 icon
entries by listing prefix and invalidates the public listing data cache.
Community republish, unpublish, admin hard delete, and account deletion remove
icon entries for the listing.

## Service layer

Core logic: `packages/worker/src/community/`

| Module         | Role                                                                |
| -------------- | ------------------------------------------------------------------- |
| `service.ts`   | Publish, unpublish, search, fork, rate, report, admin resolution    |
| `repo.ts`      | D1 queries                                                          |
| `snapshot.ts`  | KV snapshot I/O                                                     |
| `fork-scan.ts` | Manifest rewrite + cross-scope `kody:@…` / `kody.dependencies` scan |
| `og-image.ts`  | Community listing 1200×630 PNG on the shared `#worker/og` pipeline  |
| `types.ts`     | Shared record types                                                 |

`publishCommunityListing` validates MIT license, README `## Intent`, published
commit, and ban status; copies published source into KV; upserts D1 metadata.

`forkCommunityListing` reads the KV snapshot, rewrites `package.json` name/kody
id to the forker's scope, scans cross-scope references, calls
`ensureEntitySource` + `syncArtifactSourceSnapshot`, and records
`community_forks` — **without** inserting `saved_packages`.

`rateCommunityListing` requires a prior fork row for the rater and rejects
ratings from the listing owner. `reportCommunityListing` stores denormalized
listing metadata for the admin queue.

## MCP capabilities

Domain module: `packages/worker/src/mcp/capabilities/community/`

Capabilities:

- `community_publish`
- `community_unpublish`
- `community_search`
- `community_get`
- `community_fork`
- `community_rate`
- `community_report`

Register the domain in `builtinDomains` and `capabilityDomainNames` like other
builtin domains (see [Adding capabilities](./adding-kody.md)). Do not surface
community listings through the general capability/package search path.

## Public routes and Open Graph images

App handlers: `packages/worker/src/app/handlers/community*` (index, detail,
og:image).

Client routes: `packages/worker/client/routes/community*`

- `/community` — searchable index of active listings
- `/community/:listingId` — metadata, ratings, README, fork prompt, report link
  (report requires login)
- `/community/:listingId/icon/:iconCommit` — cached package icon or generated
  fallback; serves the current icon commit or the pinned snapshot commit, and
  rejects stale commit URLs

Shared OG rendering lives in `packages/worker/src/og/`: a light-mode palette
mirroring app design tokens, satori layout + resvg rasterization, and the
`publicOgPages` registry. Static public pages serve generated images from
`/og/:page.png` (page ids such as `home`, `community`, `login`). Community
listing cards use `og-image.ts` on that same pipeline and are served at
`/community/:listingId/og.png` (package identity as the visual hero — community
icon, package name, and byline — with a truncated muted description as
supporting text, then star rating and fork count).

## Admin moderation

Handler: `packages/worker/src/app/handlers/admin-community-reports*`

Route: `/admin/community-reports` (admin role)

Queue shows reporter, reason, and listing metadata. Actions use double-confirm:

| Action                      | Effect                                                           |
| --------------------------- | ---------------------------------------------------------------- |
| Dismiss                     | Close report, listing unchanged                                  |
| Delist                      | `status = delisted`, blocks owner re-publish and unpublish       |
| Hard delete                 | Remove listing, KV snapshot, and ratings                         |
| Ban reporter / ban reportee | `community_bans` row; user cannot publish, fork, rate, or report |

`resolveCommunityReport` in `service.ts` implements dismiss, delist, and delete.
`banCommunityUser` / `unbanCommunityUser` manage community-wide bans.

## Inert fork mechanism

Forks create an **`entity_sources`** row and Artifacts snapshot but **no**
`saved_packages` row. Without a saved package row:

- package exports, jobs, services, subscriptions, and apps do not register
- `kody:@…` imports from the fork do not execute
- search and execute cannot treat the fork as a live saved package

Activation happens only when the forker runs `repo_publish_session`, which
inserts `saved_packages` through the normal publish transaction. Repo checks
reject publishes that still contain cross-scope static imports or foreign
`kody.dependencies` entries (`fork-scan.ts` surfaces these at fork time).

## Search ranking

`searchCommunityListings` ranks **active** listings only:

1. Build a search document from name, kody id, description, tags, search text,
   and a README snippet.
2. Score with the same lexical + deterministic-embedding blend used for
   capability search (`blendLexicalAndVectorScore`, `deterministicEmbedding`).
3. Multiply by a **Bayesian average** of star ratings:

   prior mean **3.25**, prior weight **5**

   `(5 × 3.25 + count × averageStars) / (5 + count)`

Empty queries sort by Bayesian score, then `publishedAt`.

`computeCommunityBayesianScore` in `service.ts` implements the prior so a few
5-star ratings do not beat many good ratings.

## Isolation invariants

- Forks are copies; **no cross-user `kody:@…` import ever resolves**.
- The only deliberate cross-user data flows are public listing snapshots and
  aggregate ratings.
- Owner `userId` is not exposed on public pages or community capability
  responses; package name scope reveals the owner's username by design.
- Community results stay out of general MCP `search` and per-user package vector
  indexes.

## Related docs

- [Packages and manifests](./packages-and-manifests.md) — saved package model
- [Repo-backed editing sessions](../use/repo-sessions.md) — fork activation path
- [Adding capabilities](./adding-kody.md) — domain registration
- [Primitives map](./architecture/primitives.yaml) — `community-listings`
  primitive entry
