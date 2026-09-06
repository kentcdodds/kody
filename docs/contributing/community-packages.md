# Public packages

**Public / private** is repo visibility. **Community** is the catalog place
(`/community`, MCP `community` domain), not a package kind. A listing is the
catalog row. See [0046](./decisions/0046-community-is-the-catalog.md).

Community listings let users on the same deployment share **pinned snapshots**
of published saved packages. Listings are public read; forks stay **inert**
until the forker publishes through a repo session. See
[Public packages (usage)](../use/community-packages.md) for agent-facing
workflows.

## Architecture overview

```
Owner sets visibility public (packageUpdate)
        │
        ▼
D1 saved_packages.is_private = 0 + community_listings row
        │              KV source snapshot keyed by SHA
        ▼
Public /community + /@username/:name + /tree/:ref + /settings
        │
        ▼
Visitor forks ──► communityFork ──► entity_sources (no saved_packages row)
        │                              copy of HEAD, inert until publish
        ▼
repoOpenSession → review → fix imports → repoPublishSession
        │                              (optional absorbed_upstream_commit)
        ▼
Live saved package in forker's account
```

Community search and capabilities live in the **`community`** MCP domain. They
are intentionally **not** merged into the general MCP `search` tool or saved
package vector indexes.

## Storage

### D1 tables

The squashed baseline (`packages/worker/migrations/0001-squashed-init.sql`)
defines the community tables and profile columns.

| Table                | Purpose                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `community_listings` | Listing metadata, pinned commit, optional `package_version` (`package.json#version`), browse `category`, status (`active` / `delisted`) |
| `community_forks`    | Fork records linking listing, forker, and inert `source_id`                                                                             |
| `community_ratings`  | Per-user ratings (upsert on `listing_id` + `user_id`)                                                                                   |
| `community_reports`  | Reports with denormalized `listing_name` / `listing_owner_user_id`                                                                      |
| `community_bans`     | Community-wide bans (publish, fork, rate, report)                                                                                       |

| Table / column                    | Purpose                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `users.display_name`, `users.bio` | Optional public profile fields                                                   |
| `users.profile_visibility`        | `public` (default) or `private`                                                  |
| `saved_packages.is_private`       | Repo visibility (`0` public / catalog, `1` private). Not `package.json#private`. |
| `user_repos.is_private`           | Same visibility flag on plain repos (default private).                           |
| `community_activity_events`       | Stored `listing_published` / `listing_updated` events only                       |

Activity actor columns store the MCP **stable user id**
(`users.stable_user_id`), matching other community ownership columns such as
`community_listings.owner_user_id`.

`saved_packages.is_private` defaults to `1`. Visibility is a repo setting
(`packageUpdate` / `repoUpdate`), not a `package.json#private` projection.
Active community listings backfill to public; leftover `"private": false`
teasers stay private.

Profile activity reads stored `community_activity_events` plus public forks from
`community_forks`. Forks appear only while the forker's saved package copy has
`is_private = 0`. Ratings are never projected into profile activity.

`community_forks.origin_commit` is the origin SHA the fork last absorbed. It
starts as HEAD copied at fork time. When origin HEAD later moves, `packageGet` /
`packageList` set `listing_ahead`, and the owner's `/@username` profile plus the
listing page replace Installed / Forked with a **Fork outdated** button. Package
search hits and `{kodyId}:package` entity detail also set `listingAhead`.
Clearing the banner is done by publishing with `repoPublishSession` and
`absorbed_upstream_commit`; that does not copy files.

`community_listings` enforces one listing per `(owner_user_id, package_id)`.
Admin **delist** sets `status = 'delisted'`, blocks owner re-publish, and blocks
owner unpublish. **Hard delete** (admin report action) removes the listing row,
KV snapshot, and ratings.

There is no trusted-listing mark. Public listing records expose
`trusted: false`. `POST /community/:listingId/trust.json` returns 410.

Admin **featured** marks live in `featured_at` and highlight onboarding starter
packages. Featured is editorial only (`featured_at IS NOT NULL`). Operators
publish official starters under a platform scope (for example `@kody`) by
passing `package_scope` while holding a package scope grant; see
[Platform accounts](./architecture/platform-accounts.md).
`listFeaturedCommunityListings` feeds the onboarding page (slim
`OnboardingFeaturedListing` shapes, capped at 12). Surfaces: the `Featured`
badge on the detail page, the admin-only toggle
(`POST /community/:listingId/feature.json`, audited), the admin-only
`communitySetFeatured` capability, and onboarding Steps 2–3: Step 2 offers
official one-click access (Notion, Linear, Atlassian, Stripe, Sentry, Canva)
plus the matching `@kody/*-mcp` helper, a custom MCP URL, Advanced provider
guides, Just-try-Kody zero-auth examples, or skip as the quicker first-value
path. Official `@kody/*` listings are catalog and fork source — person accounts
run the owned copy, not the platform package. Step 3 leads with an ad hoc
execute → persist prompt. Step 2 Connect forks the matching `@kody/*-mcp`
listing automatically. Signed-in onboarding, `/community` cards, and listing
detail overlay a per-request `viewerInstall` when the viewer already has a
matching slug saved package or a `community_forks` row for that listing, so
those surfaces show Copy prompt instead of Install. `communityGet` exposes the
`featured` flag. Onboarding loads up to 12 featured listings.

Reports survive listing deletion via denormalized listing name and owner on the
report row.

### KV snapshots

Pinned file trees live in `BUNDLE_ARTIFACTS_KV` under:

`community-snapshot:v1:{listingId}`

`packages/worker/src/community/snapshot.ts` reads and writes `CommunitySnapshot`
(`version`, `listingId`, `pinnedCommit`, `files`, optional `communityIconPath`,
`createdAt`). Publish and re-publish overwrite the snapshot; unpublish and hard
delete remove it. Binary icon bytes are omitted from the text-backed `files`
map; the path metadata lets the icon route retrieve bytes from Artifacts. The
public `/@owner/kody-id/tree/:ref` explorer reads this snapshot (not a live git
checkout). Leftover `/files` URLs 301 to `/tree/{defaultBranch}`.

### Community icon cache

Community listing icons are derived lazily from the listing's **icon commit**:
the owner package's current `entity_sources.published_commit` (falling back to
the listing's pinned commit when the source row is gone). Listing reads join the
entity source, so a plain package publish moves the icon commit forward — and
with it the icon URL — without a community republish. `@epic-web/cachified`
stores a small descriptor in `BUNDLE_ARTIFACTS_KV` under
`derived-cache:v1:community-icon:v3:{listingId}:{commit}`. The processed bytes
live in the private `COMMUNITY_ASSETS` R2 bucket under
`community-icon:v3/{listingId}/{commit}/asset`.

On a descriptor cache miss, the icon service resolves the standardized root
`community-icon.*` path (from the pinned snapshot when serving the pinned
commit, otherwise by probing the Artifacts git repo at the icon commit), reads
the bytes, validates them, and writes the derived asset to R2 before returning
the descriptor. A dangling descriptor is deleted and regenerated once. Packages
without an icon receive a generated fallback: a deterministic swirl from the
package name (`packages/worker/src/community/community-icon-fallback.ts`). Every
accepted source (SVG rasterized first, then PNG, WebP, and JPEG) is fitted
through the Cloudflare Images binding to a 256-pixel WebP (`fit: scale-down`,
quality 90). Publish and account-deletion cleanup also remove leftover
`community-icon:v1` and `community-icon:v2` keys.

The icon route serves only the current icon commit and the pinned commit; stale
commit URLs 404. Package publish (`finalizePublishedEntitySource`) calls
`refreshCommunityIconForPackagePublish`, which prunes superseded KV/R2 icon
entries by listing prefix and invalidates the public listing data cache.
Community republish, unpublish, admin hard delete, and account deletion remove
icon entries for the listing.

## Service layer

Core logic: `packages/worker/src/community/`

| Module               | Role                                                                |
| -------------------- | ------------------------------------------------------------------- |
| `service.ts`         | Publish, unpublish, search, fork, rate, report, admin resolution    |
| `profile-service.ts` | Profiles, profile activity, public package lists                    |
| `profile-repo.ts`    | D1 for profiles, activity events, and public package lists          |
| `install.ts`         | One-click install: fork + publish checks + projection publish       |
| `repo.ts`            | D1 queries                                                          |
| `activity-*`         | Admin activity feed and durable admin subscription dispatch         |
| `snapshot.ts`        | KV snapshot I/O                                                     |
| `fork-scan.ts`       | Manifest rewrite + cross-scope `kody:@…` / `kody.dependencies` scan |
| `og-image.ts`        | Community listing 1200×630 PNG on the shared `#worker/og` pipeline  |
| `types.ts`           | Shared record types                                                 |

`publishCommunityListing` has no MIT, logo, Intent, or personal-content gates.
Agents follow a hygiene pass in `package_authoring` before flipping public; the
Worker does not scan or block on that review. It requires a published commit and
that the owner is not community-banned. It upserts D1 metadata including
optional browse `category` from `package.json#kody.category` or well-known tags,
and writes a SHA-keyed source snapshot.

`forkCommunityListing` reads the KV snapshot, rewrites `package.json` name/kody
id to the forker's scope, scans cross-scope references, calls
`ensureEntitySource` + `syncArtifactSourceSnapshot`, and records
`community_forks` — **without** inserting `saved_packages`.

`communityFork` returns request-scoped `serverTiming` entries
(`{ name, durationMs }`), the same shape as `execute`. They are not written to
D1 or Analytics Engine. Nested `bootstrap-*` phases come from the RepoSession
Durable Object; `bootstrap-source` is the RPC wall clock, including isolate
startup. Subtract the nested bootstrap phases from `bootstrap-source` to
estimate cold start. `Date.now()` in Workers only advances across I/O, so
CPU-only steps may report `0`.

`rateCommunityListing` requires a prior fork row for the rater and rejects
ratings from the listing owner. `reportCommunityListing` stores denormalized
listing metadata for the admin queue.

`listCommunityActivityForAdmin` exposes a role-gated metadata projection over
forks and ratings. Rows contain public listing identity, acting username,
timestamp, and rating scores; they omit rating notes, forked source/package ids,
stable user ids, and package source. Rating rows use `updated_at`, so the feed
shows the latest value for each user/listing rating. Since one-click install and
agent fork both persist through `community_forks`, historical data cannot
distinguish them and reports both as `fork`. Fork writes snapshot the public
listing name and kody id, preserving readable fork provenance after a later hard
delete. Rows without recoverable listing identity use explicit deleted/unknown
placeholders. Actor usernames resolve through the unique `users.stable_user_id`
index; neither email nor stable user id enters the feed or event.

`installCommunityListing` (one-click install) composes `forkCommunityListing`
with `runRepoChecks` over the fork's rewritten snapshot files and, when checks
pass, `refreshSavedPackageProjection` — the same projection step
`repoPublishSession` ends with, so declared jobs are scheduled immediately. When
checks fail (typically cross-scope imports), the fork stays inert and the
failing checks are returned for agent follow-up. The HTTP surface is
`POST /community/:listingId/install.json` (authenticated). Official `@kody/*`
listings skip acknowledgement. Third-party listings must send
`acknowledged: true` or the handler responds `409`. There is intentionally
**no** MCP capability for install: agents must go through `communityFork` +
repo-session review, so a prompt-injected agent cannot silently activate
community code.

## MCP capabilities

Domain module: `packages/worker/src/mcp/capabilities/community/`

Capabilities:

- `communityPublish`
- `communityUnpublish`
- `communitySearch`
- `communityGet`
- `communityFork`
- `communityForkAdopt`
- `communityRate`
- `communityProfileGet` / `communityProfileUpdate`
- `communityReport`
- `communitySetFeatured` (admin-only via `requiredRole`)

The admin domain also exposes `adminCommunityActivityList`, guarded by
`requiredRole: 'admin'`, for the narrow operator activity feed.

Register the domain in `builtinDomains` and `capabilityDomainNames` like other
builtin domains (see [Adding capabilities](./adding-capabilities.md)). Do not
surface community listings through the general capability/package search path.

## Public routes and Open Graph images

App handlers: `packages/worker/src/app/handlers/community*` (index, detail,
og:image).

Client routes: `packages/worker/client/routes/community*`

- `/community` — searchable index of active listings, grouped by category on the
  unfiltered browse page (`?category=` filters to one category). Empty
  categories omit their chip; an empty catalog hides the facet and sort row.
- `/@:username/:kodyId` — the canonical package page, resolved from the owner
  plus the listing slug (JSON companion:
  `/profiles/:username/packages/:kodyId.json`). `username_redirects` and
  `package_kody_id_redirects` map prior owner usernames and package slugs to a
  redirect at that URL
- `/@:username/:kodyId/tree/:ref(/*relativePath)` — GitHub-lite source explorer
  (default-branch name from git, SHA, or another branch). `HEAD` and leftover
  `/files` URLs 301 to `/tree/{defaultBranch}` (`main` when lookup misses)
- `/community/:listingId` — the same page by listing id; redirects to the
  canonical URL. Metadata, ratings, README, one-click install (requires login
  and a generic confirm), fork prompt, and report link (report requires login)
- `/community/:listingId/icon/:iconCommit` — cached package icon or generated
  fallback; serves the current icon commit or the pinned snapshot commit, and
  rejects stale commit URLs

Shared OG rendering lives in `packages/worker/src/og/`: a light-mode palette
mirroring app design tokens, satori layout + resvg rasterization, Twemoji images
for emoji graphemes (`loadAdditionalAsset` — the Latin OG fonts have no color
emoji), and the `publicOgPages` registry. Static public pages serve generated
images from `/og/:page.png` (page ids such as `home`, `community`, `login`).
Community listing cards use `og-image.ts` on that same pipeline and are served
at `/community/:listingId/og.png` (package identity as the visual hero —
community icon, package name, and byline — with a truncated muted description as
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

The first successful listing publish enqueues `{ eventId, listingId }` for
durable `community.listing.published` delivery (same admin fan-out as activity
events). Republishes write `listing_updated` for profile activity but do not
enqueue this topic. Enqueue failures are logged and never fail
`communityPublish`. See
[the subscription guide](../guides/package-subscriptions.md#communitylistingpublished-admins)
for the handler payload.

## Inert fork mechanism

Forks create an **`entity_sources`** row and Artifacts snapshot but **no**
`saved_packages` row. Without a saved package row:

- package exports, jobs, subscriptions, and apps do not register
- `kody:@…` imports from the fork do not execute
- search and execute cannot treat the fork as a live saved package

Activation happens through two paths: the forker runs `repoPublishSession`, or a
one-click `installCommunityListing` whose publish checks pass — both end in the
same saved-package projection. Repo checks reject publishes that still contain
cross-scope static imports or foreign `kody.dependencies` entries
(`fork-scan.ts` surfaces these at fork time).

## Search ranking

`searchCommunityListings` ranks **active** listings only:

1. Build a search document from name, kody id, description, tags, search text,
   and a README snippet. Category filters apply after scoring.
2. Score with the same lexical + deterministic-embedding blend used for
   capability search (`blendLexicalAndVectorScore`, `deterministicEmbedding`).
3. Multiply by a **Bayesian average** of star ratings:

   prior mean **3.25**, prior weight **5**

   `(5 × 3.25 + count × averageStars) / (5 + count)`

Empty queries sort by Bayesian score, then `publishedAt`. Pass `sort: "newest"`
(or `/community?sort=newest`) to order matching listings by `publishedAt`
descending instead. `published_at` is last community publish time: republishing
overwrites it. Pass `category` (or `/community?category=integrations`) to keep
only that browse category. Unfiltered `/community` browse groups the newest
candidates by category and shows a few cards in each section.

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
  ratings, and public profile / catalog surfaces.
- Private profiles and private packages (`profile_visibility = private`,
  `saved_packages.is_private = 1`) must not appear on public catalog reads.
- Package name scope and public profiles reveal the owner's username by design;
  browsing does not require exposing a stable owner user id on every search hit.
- Community results stay out of general MCP `search` and per-user package vector
  indexes.

Account deletion and export cover community activity through
`accountUserDataTargets` (`community_activity_events` by actor and by owned
listing), matching the multi-column pattern used for `community_reports`.

## Related docs

- [Public packages (usage)](../use/community-packages.md) — catalog, profiles,
  and ratings
- [Packages and manifests](./packages-and-manifests.md) — saved package model
- [Repo-backed editing sessions](../use/repo-sessions.md) — fork activation path
- [Adding capabilities](./adding-capabilities.md) — domain registration
- [Primitives map](./architecture/primitives.yaml) — `community-listings`
  primitive entry
