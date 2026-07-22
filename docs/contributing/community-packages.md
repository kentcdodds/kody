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

Social / profiles migration:
`packages/worker/migrations/0068-community-social.sql`

| Table / column                    | Purpose                                                           |
| --------------------------------- | ----------------------------------------------------------------- |
| `users.display_name`, `users.bio` | Optional public profile fields                                    |
| `users.profile_visibility`        | `public` (default) or `private`                                   |
| `saved_packages.is_private`       | Projection of `package.json#private` for profile/timeline filters |
| `user_follows`                    | Follow edges keyed by MCP stable user ids                         |
| `community_stars`                 | Listing stargazers (bookmark stars; not 1–5 ratings)              |
| `community_activity_events`       | Stored `listing_published` / `listing_updated` events only        |

Follow, star, and activity actor columns store the MCP **stable user id**
(`users.stable_user_id`), matching other community ownership columns such as
`community_listings.owner_user_id`.

`saved_packages.is_private` defaults to `1` in the migration (safe until
manifests are read). Package save/publish paths keep the column in sync with
`package.json#private`. Operators can recompute every row with
`POST /__maintenance/backfill-package-privacy` (Bearer
`CAPABILITY_REINDEX_SECRET`), implemented in `maintenance-handler.ts`.

### Derived timeline events

Timelines merge stored `community_activity_events` with **read-time derived**
fork and star items from `community_forks` / `community_stars`. Forks appear
only while the forker's saved package copy has `is_private = 0`; unstarring
drops the star item immediately. Ratings are never projected into timelines.
Storing only publish/update events avoids orphaned fork/star timeline rows when
privacy flips or a star is removed — see `social-repo.ts` / `social-service.ts`.

`community_listings` enforces one listing per `(owner_user_id, package_id)`.
Admin **delist** sets `status = 'delisted'`, blocks owner re-publish, and blocks
owner unpublish. **Hard delete** (admin report action) removes the listing row,
KV snapshot, and ratings.

Admin **trust** marks live in `trusted_commit` / `trusted_by_user_id` /
`trusted_at` (migration `0059-community-trusted-listings.sql`). A listing is
effectively trusted only while `trusted_commit = pinned_commit`, so an owner
republish (which moves the pinned commit) drops the effective mark without an
explicit revoke. `setCommunityListingTrusted` in `service.ts` sets or clears the
mark; delisted listings cannot be trusted. Surfaces: the `Trusted` badge on
`/community` cards and detail pages, the admin-only toggle on the detail page
(`POST /community/:listingId/trust.json`, audited), and the admin-only
`community_set_trusted` capability. `community_search` and `community_get`
expose the effective `trusted` flag.

Admin **featured** marks live in `featured_at` (migration
`0060-community-featured-listings.sql`) and highlight onboarding starter
packages. Operators publish official starters under a platform scope (for
example `@kody`) by passing `package_scope` to `community_publish` while holding
a package scope grant; see
[Platform accounts](./architecture/platform-accounts.md).
`setCommunityListingFeatured` in `service.ts` requires the listing to be
effectively trusted before featuring; the effective `featured` flag
(`featured_at IS NOT NULL AND trusted`) is computed in `repo.ts`, so an owner
republish that drops trust also pulls the listing from onboarding while keeping
the stored mark. `listFeaturedCommunityListings` feeds the onboarding page (slim
`OnboardingFeaturedListing` shapes, capped at 12). Surfaces: the `Featured`
badge on the detail page, the admin-only toggle
(`POST /community/:listingId/feature.json`, audited), the admin-only
`community_set_featured` capability, and the onboarding "Install a starter
package" step (square-card grid with in-place Install, then Copy prompt for
agent setup, plus a trailing Choose your own adventure card). `community_get`
exposes the effective `featured` flag. Onboarding loads up to 12 featured
listings.

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

| Module              | Role                                                                |
| ------------------- | ------------------------------------------------------------------- |
| `service.ts`        | Publish, unpublish, search, fork, rate, report, admin resolution    |
| `social-service.ts` | Profiles, follows, timeline merge, stars / stargazers               |
| `social-repo.ts`    | D1 for profiles, follows, stars, activity, public package lists     |
| `install.ts`        | One-click install: fork + publish checks + projection publish       |
| `repo.ts`           | D1 queries                                                          |
| `activity-*`        | Admin activity feed and durable admin subscription dispatch         |
| `snapshot.ts`       | KV snapshot I/O                                                     |
| `fork-scan.ts`      | Manifest rewrite + cross-scope `kody:@…` / `kody.dependencies` scan |
| `og-image.ts`       | Community listing 1200×630 PNG on the shared `#worker/og` pipeline  |
| `types.ts`          | Shared record types                                                 |

`publishCommunityListing` validates MIT license, README `## Intent`, published
commit, and ban status; copies published source into KV; upserts D1 metadata.

`forkCommunityListing` reads the KV snapshot, rewrites `package.json` name/kody
id to the forker's scope, scans cross-scope references, calls
`ensureEntitySource` + `syncArtifactSourceSnapshot`, and records
`community_forks` — **without** inserting `saved_packages`.

`rateCommunityListing` requires a prior fork row for the rater and rejects
ratings from the listing owner. `reportCommunityListing` stores denormalized
listing metadata for the admin queue.

`listCommunityActivityForAdmin` exposes a role-gated metadata projection over
forks and ratings. Rows contain public listing identity, acting username,
timestamp, and rating scores; they omit rating notes, forked source/package ids,
stable user ids, and package source. Rating rows use `updated_at`, so the feed
shows the latest value for each user/listing rating. Since one-click install and
agent fork both persist through `community_forks`, historical data cannot
distinguish them and reports both as `fork`. New fork rows snapshot the public
listing name and kody id; migration `0070-community-fork-listing-snapshots.sql`
backfills existing rows while their listings still exist, preserving readable
fork provenance after a later hard delete. Pre-snapshot orphan rows use explicit
deleted/unknown placeholders. Actor usernames resolve through the unique
`users.stable_user_id` index; neither email nor stable user id enters the feed
or event.

`installCommunityListing` (one-click install) composes `forkCommunityListing`
with `runRepoChecks` over the fork's rewritten snapshot files and, when checks
pass, `refreshSavedPackageProjection` — the same projection step
`repo_publish_session` ends with, so declared jobs are scheduled and `autoStart`
services start immediately. When checks fail (typically cross-scope imports),
the fork stays inert and the failing checks are returned for agent follow-up.
The HTTP surface is `POST /community/:listingId/install.json` (authenticated);
untrusted listings require `acknowledged_untrusted: true` or the handler
responds `409`. There is intentionally **no** MCP capability for install: agents
must go through `community_fork` + repo-session review, so a prompt-injected
agent cannot silently activate community code.

## MCP capabilities

Domain module: `packages/worker/src/mcp/capabilities/community/`

Capabilities:

- `community_publish`
- `community_unpublish`
- `community_search`
- `community_get`
- `community_fork`
- `community_rate`
- `community_star` / `community_unstar` / `community_starred_list`
- `community_profile_get` / `community_profile_update`
- `community_follow` / `community_unfollow`
- `community_timeline`
- `community_report`
- `community_set_trusted` (admin-only via `requiredRole`)
- `community_set_featured` (admin-only via `requiredRole`)

The admin domain also exposes `admin_community_activity_list`, guarded by
`requiredRole: 'admin'`, for the narrow operator activity feed.

Register the domain in `builtinDomains` and `capabilityDomainNames` like other
builtin domains (see [Adding capabilities](./adding-kody.md)). Do not surface
community listings through the general capability/package search path.

## Public routes and Open Graph images

App handlers: `packages/worker/src/app/handlers/community*` (index, detail,
og:image).

Client routes: `packages/worker/client/routes/community*`

- `/community` — searchable index of active listings
- `/community/:listingId` — metadata, ratings, README, one-click install
  (requires login; untrusted listings require a confirmed warning), fork prompt,
  report link (report requires login)
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

Successful fork and rating writes enqueue `{ eventId, kind, activityId }` for
durable `community.activity.recorded` delivery. The Queue consumer reloads the
same metadata-only projection and uses the shared admin package-subscription
fan-out, which resolves admin package owners fresh for every attempt. The event
therefore reaches only admin-owned subscribed packages and is suitable for
operator notifications such as Discord.

## Inert fork mechanism

Forks create an **`entity_sources`** row and Artifacts snapshot but **no**
`saved_packages` row. Without a saved package row:

- package exports, jobs, services, subscriptions, and apps do not register
- `kody:@…` imports from the fork do not execute
- search and execute cannot treat the fork as a live saved package

Activation happens through two paths: the forker runs `repo_publish_session`, or
a one-click `installCommunityListing` whose publish checks pass — both end in
the same saved-package projection. Repo checks reject publishes that still
contain cross-scope static imports or foreign `kody.dependencies` entries
(`fork-scan.ts` surfaces these at fork time).

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

Fork counts are live `COUNT(*)` aggregates over `community_forks` grouped by
listing id. Detail reads always count the selected listing. Browse and search
counts are also correct for every materialized result, although unfiltered
browse intentionally ranks only the newest 500 candidates. The reported
production mismatch for `@kentcdodds/github` was therefore consistent with a
data snapshot/cache artifact rather than a defect in the aggregate SQL; the
worker integration test pins that a successful fork increments the surfaced
count.

`computeCommunityBayesianScore` in `service.ts` implements the prior so a few
5-star ratings do not beat many good ratings.

## Isolation invariants

- Forks are copies; **no cross-user `kody:@…` import ever resolves**.
- Deliberate cross-user data flows are public listing snapshots, aggregate
  ratings, star counts/stargazers, and public profile / timeline surfaces.
- Private profiles and private packages (`profile_visibility = private`,
  `saved_packages.is_private = 1`) must not appear on public social reads.
- Package name scope and public profiles reveal the owner's username by design;
  browsing does not require exposing a stable owner user id on every search hit.
- Community results stay out of general MCP `search` and per-user package vector
  indexes.

Account deletion and export cover social tables through `accountUserDataTargets`
(`user_follows` on both follower and followee columns, `community_stars` by user
and by owned listing, `community_activity_events` by actor and by owned
listing), matching the multi-column pattern used for `community_reports`.

## Related docs

- [Community profiles (usage)](../use/community-profiles.md) — agent-facing
  profiles, follows, timelines, and stars
- [Packages and manifests](./packages-and-manifests.md) — saved package model
- [Repo-backed editing sessions](../use/repo-sessions.md) — fork activation path
- [Adding capabilities](./adding-kody.md) — domain registration
- [Primitives map](./architecture/primitives.yaml) — `community-listings` and
  `community-social` primitive entries
