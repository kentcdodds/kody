# Community profiles, follows, and stars

Kody users on the same deployment can publish a **public profile**, follow other
public profiles, browse a personal **timeline** of followees' public activity,
and **star** community listings (bookmarking, distinct from 1–5 star ratings).

Profiles and social graphs live in the MCP **`community`** domain alongside
[community packages](./community-packages.md). Private package source stays
isolated; social surfaces only show content that is deliberately public.

## Public profiles

Each account has profile fields:

- **Display name** — shown on the profile and activity items (falls back to
  username when unset)
- **Bio** — short public text
- **Avatar** — optional profile image (PNG, JPEG, or WebP)
- **Profile visibility** — `public` by default, or `private`

Public profiles are at `/@username`. A public profile shows display name, bio,
avatar, join date, follower and following counts, the user's **public packages**
(metadata only), and recent public activity.

### Avatars

Upload or remove an avatar from **Account → Profile** in the web UI (MCP does
not accept avatar uploads). Accepted formats are PNG, JPEG, and WebP, up to 1
MB, with each side between 64px and 4096px and an aspect ratio of at most 3:1.
Avatars appear on the public profile, in timeline and profile activity rows, and
next to public stargazers on listing pages. Private profiles still keep the
avatar for the owner; other users do not see it.

Package privacy follows `package.json#private` (projected onto
`saved_packages.is_private`):

- Packages with `"private": true` (or missing `private` on create) do not appear
  on the public profile.
- Public packages that are **not** community-published expose name, kody id,
  description, and tags only — never README or source, and they cannot be forked
  from the profile.
- Community-published packages on the profile carry a listing signifier and a
  fork affordance (same inert-fork rules as
  [community packages](./community-packages.md#forking-a-listing)).

### Private mode

When visibility is `private`:

- `/@username` and public profile reads return not found (404)
- The user cannot be followed
- They do not appear in public stargazer lists
- Their activity does not appear on other users' timelines

The account owner can still read and update their own profile (including while
private) through `community_profile_get` / `community_profile_update`.

## Following and the timeline

Signed-in users can follow public profiles with no approval step. Private
profiles reject follows.

`/timeline` (signed-in) lists public activity from accounts you follow, newest
first. Timeline item types:

| Type              | Source                                                         |
| ----------------- | -------------------------------------------------------------- |
| Listing published | Stored when a listing is published                             |
| Listing updated   | Stored when a listing is re-published                          |
| Listing forked    | Derived from `community_forks` while the forked copy is public |
| Listing starred   | Derived from `community_stars` while the star remains          |

Fork items disappear if the forker marks that saved package private again.
Unstarring removes the star item. **Ratings never appear** on timelines.

## Stars vs ratings

**Stars** (`community_star` / `community_unstar`) are a public stargazer
bookmark on a listing: star counts on listings, a stargazer list (public-profile
users only), and a starred-packages view for the signed-in user.

**Ratings** (`community_rate`) remain the separate 1–5 usefulness /
adaptation-effort scores after forking. They are unchanged and stay off
timelines. See [Ratings](./community-packages.md#ratings).

## Capabilities

Use the MCP `community` domain:

- `community_profile_get` — read a profile by username (own private profile
  included when signed in as that user)
- `community_profile_update` — update display name, bio, and visibility
- `community_follow` / `community_unfollow` — follow or unfollow a public
  profile
- `community_timeline` — chronological public activity from followees
- `community_star` / `community_unstar` — star or unstar a listing
- `community_starred_list` — list listings the signed-in user has starred

Listing search/get also expose `star_count`; `community_get` can include
stargazers and owner profile linkage for public owners. Package listing
workflows stay in [Community packages](./community-packages.md).

## Privacy

Profile fields are user-controlled public content when visibility is public.
Account [export and deletion](./privacy.md) include follows (either side of an
edge), stars, activity events, and profile columns. Cross-user package source
isolation is unchanged.
