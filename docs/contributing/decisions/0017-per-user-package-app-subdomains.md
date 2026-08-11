# 0017: Per-user subdomains for hosted package apps

- **Status:** accepted
- **Date:** 2026-08-11

## Context

Hosted package apps execute author-supplied HTML and JavaScript. Production
already isolates them from the first-party app origin via a separate registrable
domain (`PACKAGE_APP_BASE_URL`, `kodyapps.dev`) and credential stripping, but
every owner's apps still shared one origin on that domain. One user's package
could reach another user's `kody_pkg_session`-authorized endpoints from the
browser — a smaller blast radius than first-party access, but not zero.

Alternatives considered:

- **Stay on one shared package-app origin.** Simpler DNS and routing, but
  user-to-user browser isolation remains incomplete.
- **Per-package subdomains** (`{kodyId}.kodyapps.dev`). Stronger same-owner
  isolation, but multiplies DNS/certificate surface and complicates the handoff
  and `packageContext` contract for every package.
- **Path-only isolation with stricter CSP on package apps.** Would still leave
  same-origin cookie and storage sharing; CSP cannot be applied to author code
  without breaking real apps.

Usernames had allowed underscores, which are invalid in DNS labels and would
block `{username}.kodyapps.dev` for affected accounts.

## Decision

Serve production hosted package apps on **per-user subdomains** of the
package-app apex:

- Public URL shape: `https://{username}.kodyapps.dev/packages/{kodyId}/{path}`
- The apex (`kodyapps.dev`) serves no package code: `/` redirects to the app
  origin; legacy `/@user/packages/...` paths redirect to the owning subdomain;
  everything else `404`s.
- The app-origin path `/@{username}/packages/...` remains the authenticated
  entry point and redirects into the handoff on the owner's subdomain.
- Package-app session cookies on secure requests use the
  `__Host-kody_pkg_session` name so browsers reject any variant with a `Domain`
  attribute (cookie-tossing defense before Public Suffix List entry). Insecure
  local HTTP keeps plain `kody_pkg_session`.
- Serving requires session account username == subdomain label == path owner
  (fixation defense).
- Mutating requests on a subdomain require any `Origin` header to match the
  subdomain itself: sibling subdomains stay same-site until the PSL entry, so a
  `SameSite=Lax` cookie would otherwise attach to a cross-subdomain mutation
  from a browser holding sessions for two accounts.
- New and changed usernames are strict DNS labels (lowercase alphanumeric +
  hyphens; underscores banned). Recognition of stored usernames stays lenient
  (two-tier validation) so legacy underscore accounts keep display names, public
  lookup, and inbound email routing; they must rename before hosted apps work
  (the app origin answers their package-app entry with a `409` rename prompt).
- `packageContext.appBasePath` on a subdomain is `/packages/{kodyId}` (no
  `/@{username}` prefix); inline non-production serving keeps the path-based
  mount. Well-behaved packages that use `hostedUrl` / `appBasePath` stay
  transparent.
- Untrusted markdown refuses `/packages/...` links on any host in addition to
  `/@...`.
- **Same-user package-to-package isolation is deliberately deferred:** two
  packages of one owner still share that owner's subdomain origin.
- **Operational follow-up:** submit `kodyapps.dev` to the Public Suffix List
  (`_psl` TXT record + PR to publicsuffix/list) for defense-in-depth.

## Consequences

- User-to-user browser isolation for hosted apps is complete; same-owner
  cross-package reachability remains an accepted residual risk (documented in
  [`security.md`](../security.md)).
- Production deploys require wildcard DNS and a `*.kodyapps.dev/*` Worker route
  (see [`setup-manifest.md`](../setup-manifest.md)).
- Username renames become mandatory for underscore holders before subdomain
  hosting works.
- `parsePackageSearchIdentity`, status probes, and author docs must recognize
  both subdomain URLs and legacy path shapes during transition.
- Revisit per-package subdomains only if same-owner isolation becomes a reported
  abuse vector or a product requirement.
