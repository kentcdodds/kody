# 0046: Community is the catalog; public is the visibility word

- **Status:** accepted
- **Date:** 2026-09-01

## Context

[0043](./0043-repo-visibility-no-community-kind.md) removed the
community-package kind. Agents, Discord, and some MCP strings still say
“community package” or “community listing” as if that were the product type.
GitHub’s analogy is public vs private repos; “community” there is a forum, not
visibility.

Kody still has a real catalog named Community (`/community`, MCP `community`
domain, Discord `#📦-community-packages`). Public **packages** appear there.
Public plain repos store the same visibility flag and do not appear yet.

## Decision

Do not call a public package a “community package.” Do not rename the catalog
off `/community` (or the MCP `community` domain) to match GitHub Explore.

- **Public / private** — repo visibility, the share switch.
- **Community** — the catalog place and the official Discord server.
- **Listing** — internal catalog row / snapshot. Keep `listing_id`,
  `community_listings`, `communityPublish` (visibility alias), and
  `community.listing.published` until a dual-declare cut. Do not put “listing”
  in Discord posts or human share copy.

## Consequences

First-publish Discord copy says **public package**. Nav and the Discord channel
stay Community / `#📦-community-packages` (packages in that catalog). MCP errors
and capability descriptions still say “community listing”; that is leftover
copy, not a reason to rename tables or topics. Revisit if `/community` becomes a
public-repo catalog, or if we dual-declare a package-shaped publish topic.
