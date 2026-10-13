# Direct-upload host token

**Kind:** [two-way door](../../principles/two-way-doors.md) design note. Not an
ADR. Do not ship this with the streaming gateway-fetch work.

## Problem

Large secret-bearing uploads today go through the fetch gateway: origin fills
placeholders, then sends the body upstream. That costs Worker bandwidth and CPU
and hits platform request-body limits (about 100 MiB on Cloudflare Workers
Free/Pro, even on the streaming hop). Providers that already offer a
direct-to-storage upload (Dropbox upload session, similar signed PUT URLs) make
the gateway a detour.

## Option

Mint a short-lived **host-scoped upload token** that only the CLI host process
holds. Sandboxed package code never sees it. A sandboxed `fetch` that opts in
asks the host to upload the bytes directly to the provider; the host attaches
the token and streams the body off-box.

The fetch gateway remains the **default**. Direct upload is an opt-in for
specific large-upload providers, not a replacement for placeholder fill.

## Security

- **Confused deputy.** A malicious package must not be able to point the host at
  an arbitrary URL and spend the token. Scope the token to a host and path
  prefix the provider issued, plus an expiry. Reject any upload target that does
  not match.
- **Token scope.** Bind host + path + expiry (and the calling org / package
  stamp if the mint path can attest them). Do not issue a bearer that works as a
  general credential.
- **Sandbox isolation.** The token lives only in the CLI host process. It must
  not appear in workerd, package source, capability arguments, logs, or
  `Response` bodies the sandbox can read.
- **Revocation.** The mint path must be able to revoke or let the token expire
  quickly. Losing the CLI process drops the token; a stolen host token should
  not outlive its expiry.

## Open questions

For a later decision (not this change):

- Which providers? Dropbox-only first, or a generic “host uploads to this signed
  URL” shape?
- Where is the token minted? Open API native route, CapabilityProxy method, or a
  provider-specific capability?
- How does package code opt in? Explicit host method, a header, or a
  `kody:runtime` helper?

## Recommendation

Do not ship a direct-upload token in this change. Ship the streaming
gateway-fetch hop so local multipart and large bodies match hosted fill. Revisit
this note if Worker body limits or bandwidth become the constraint that
streaming cannot absorb.

This is cheap to reverse: no stored user shape, no published package contract.
Record an ADR only if a later change actually ships a token.
