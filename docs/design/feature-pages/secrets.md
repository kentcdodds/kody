# Secrets feature page concept

## Direction

A violet mailroom for credentials. An agent can address a request, but the key
joins the request behind a physical-looking partition on its way out. The page's
central object is a working cutaway illustration of that boundary, not a
dashboard or a decorative vault. Kody the koala operates the little dispatch
window, its lantern glowing violet. Warm paper, oversized Bricolage Grotesque
type, Wix Madefor Text body copy, ink outlines, translucent violet glass. Use
`--primitive-secrets: oklch(0.6 0.22 300)` from
`packages/worker/public/styles.css:124`; respect its dark variant. Violet
carries the story, other feature colors appear only in neighbor links.

The headline is: **Your agent can use the key. It can't read it.**

Pitch: **Give your agent the API access it needs. Kody keeps the credential out
of the conversation and sends it only to hosts you approve.**

Primary action: **Connect your agent** using the existing onboarding
destination. Secondary: **Try a request**, which focuses the interactive
illustration. No eyebrow, security score, shield grid, or extra introductory
copy.

## Document-grounded facts and limits

All paths below are relative to
`/Users/tannerlinsley/.codex/worktrees/b826/kody`.

- `docs/guides/secrets.md`, sections “The rule: there is no secret_get” and “How
  code uses a secret”: agents receive metadata and opaque references. There is
  no secret-value read capability. Substitution happens on the final serialized
  outbound request in secret-aware fetch. This supports the central headline
  within Kody's described secret mechanism, not a claim that arbitrary tools or
  all possible credential handling are safe.
- `docs/guides/secrets.md`, “Two approvals, both yours”: host allowlists govern
  destinations. Empty allowlists block placeholder fetches. The account owner
  approves hosts. Package permission is separate. Authored packages and
  reviewed/adopted forks have automatic read/use; unadopted forks need an
  explicit grant. Never imply every package starts denied or that every use
  needs two clicks.
- `docs/guides/secrets.md`, “Expiry”: expired secrets remain listed but stop
  resolving. This is Kody-side expiry, not evidence of provider-side token
  revocation.
- `docs/guides/secrets.md`, “Scopes”: user secrets can serve approved packages;
  package secrets require package context. OAuth tokens live on integrations,
  not in the secrets list.
- `docs/guides/secret-providers.md`: bound saved packages implement vault
  access. Kody core does not talk to the vault itself. The illustrated 1Password
  flow is a custom-provider setup, not evidence of a universal built-in
  one-click integration. Item websites form its host allowlist, HTTPS is
  required, saved packages need grants, ad hoc execute does not. Search does not
  crawl vaults. Only the account owner binds or unbinds providers.
- `docs/guides/locked-gmail-drafts.md`: drafts-only behavior requires a thin
  package whose surface excludes send, a publish lock, and an integration usage
  lock. The Google token retains its original scope. This is an adjacent example
  of constrained behavior, not a secrets storage feature or a reduction of OAuth
  permissions.
- Brand grounding: `packages/worker/universal/landing-home-copy.ts` positions
  secrets as “Keys and tokens the model never sees.”
  `packages/worker/universal/landing-lantern.ts` supplies the secrets orb asset;
  `packages/worker/client/routes/landing-primitives.tsx` supplies the existing
  interaction and no-JS accessibility baseline. Do not change locked homepage
  strings.

Avoid unsupported claims about encryption algorithms, zero knowledge,
certifications, SOC 2, HIPAA, data residency, customer-managed encryption, audit
trails, preventing every leak, or universal prompt-injection protection.
Approved API hosts do receive the credential. The page should explain this
directly in the illustration.

## Four page beats

### 1. Send the request, keep the key out of chat

Hero composition spans nearly the full width: large headline sits top-left;
below it a long cutaway dispatch counter takes over the page. One violet key
remains behind its glass partition. On the left, the agent's envelope contains
only `{{secret:<name>}}`, explicitly illustrative syntax. On the right, an
approved API destination receives an authenticated request. The credential
itself is never rendered, even as a fake key.

Visible labels have jobs: **Agent sees: secret reference**, **Kody adds the
credential**, **Approved API receives it**. Keep the middle label attached to
the physical boundary. Show a small “Illustration” label so the interaction
cannot be confused with real account settings.

Controls: destination radio buttons **Approved host** and **Unapproved host**,
then **Send example request**. The first yields **Request sent to the approved
host**. The second stops the envelope before the partition with **Blocked. This
host isn't approved.** The server-side distinction is made tangible. Switching
tabs or scrolling must not silently run a request. This is a local simulation
with no real API traffic or entered credentials.

### 2. You choose where it goes, and which packages can use it

A short editorial spread, not another three-card grid. Two physical approval
slips cross the boundary drawing: one names **Host**, one names **Package**.
Tapping either opens its brief explanation in place.

Draft copy: **Approve the destination. Control the package.**

**Host approval decides where a secret may be sent. Package access decides which
saved packages can use it. Packages you write and forks you adopt after
reviewing the source get use automatically. Other packages need your approval.**

Link: **How approvals work** to `/docs/secrets`.

A single expiry date stamped on the key tag is enough to introduce the secondary
behavior: **Set an expiry. Kody stops sending the secret when it expires.** No
fake countdown or invented incident metric.

### 3. The key can stay in your vault

The physical key drawer pulls out sideways and reveals a vault reference in
place of a saved credential. This is a different source feeding the same
boundary, so reuse the diagram's right side instead of inventing a second
security story.

Draft copy: **Already in your password manager? Leave it there.**

**Bind a custom secret provider to use vault items through the same request
boundary. The agent works with a reference, and the model never sees the
value.**

Link: **Set up a secret provider** to `/docs/secret-providers`. A restrained
example tag can say **1Password provider example**. It must not imply
out-of-the-box availability without setup.

### 4. Let it draft. Keep send out of reach.

An envelope slips into a Gmail Drafts tray. The send plane is tied to a fixed
hook, borrowing the existing guide illustration motif. This is an example,
clearly separated from the vault mechanism.

Draft copy: **Some tokens can do more than the job should.**

**Gmail's draft permission can also send. A drafts-only package, a publish lock,
and an integration usage lock let your agent prepare replies through that
package while you review and send in Gmail. The token's Google permissions stay
the same.**

Link: **Build the drafts-only workflow** to `/docs/locked-gmail-drafts`.

End with the concrete action **Connect your agent**. Neighbor links: **Packages:
save the allowed behavior** and **Integrations: reuse signed-in connections**,
at `/features/packages` and `/features/integrations`. No generic “ready to
transform” conclusion.

## Audience relevance

Personal: store a GitHub PAT once and use it from connected agents without
pasting it into chat. Small business: let a package call the approved service
using a credential, and keep review/send with a person in the Gmail example.
Larger organizations: the custom-provider docs describe packages running in
their owning org and using that org's binding and grants. This supports a
technical discussion of org-owned bindings, but not enterprise compliance,
roles, SSO, or administrator policy claims. No separate enterprise block is
needed on this page.

## Search intent hypothesis

Likely intent clusters, without search-volume evidence: “AI agent API keys”,
“give AI agent secrets without exposing them”, “MCP secret management”, “AI
agent 1Password”, and “Gmail agent drafts without send”. Primary title proposal:
**API keys your AI agents can use without reading | Kody**. Description: **Let
your agents use API keys without putting them in chat. Approve hosts, control
package access, and connect an external vault with a custom secret provider.**

Keep the Gmail material a linked proof story rather than targeting the whole
page around Gmail. The exact mechanism and useful docs answer the intent better
than repeating security keywords.

## Accessibility and motion

Use real buttons and radios, visible focus, and a polite live result
announcement after an explicit run. Never require dragging, hovering, or
following motion to understand the boundary. The static diagram must show
source, reference, boundary, and recipient in reading order. At narrow widths
stack these four stages vertically, preserving the same semantic sequence.
Reduced motion snaps between states with no envelope travel or drawer slide.
Pause decoration offscreen and in hidden tabs. Violet alone must not communicate
allowed/blocked; use text and differing symbols. Match text contrast
independently from the brand accent. No real secret entry, fake password reveal
toggle, or masked token that suggests the agent has seen it.
