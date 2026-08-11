# Security Policy

Kody is a multi-user personal assistant. Every user gets a fully isolated
assistant, and the core security invariant is that **all data access is scoped
by `userId`** — cross-user data exposure of any kind is a vulnerability, not a
feature gap.

## Reporting a vulnerability

Please report vulnerabilities privately — do not open a public issue.

- Preferred:
  [GitHub private vulnerability reporting](https://github.com/kentcdodds/kody/security/advisories/new)
- Alternative: email [me@kentcdodds.com](mailto:me@kentcdodds.com) with
  "SECURITY" in the subject line

Kody is maintained by a solo developer, so please allow a few days for an
initial response. You'll get an acknowledgment, an assessment, and updates until
the issue is resolved. Good-faith security research against your own account is
welcome; please don't access or disrupt other users' data.

## Scope

Reports we especially care about:

- Cross-user data access (any read/write path missing `userId` scoping)
- Sandbox escapes from hosted package code (Worker Loader isolates, the fetch
  gateway, credential stripping, package-app origin isolation)
- Authentication/session flaws (password auth, OAuth/PKCE, MCP bearer tokens,
  2FA, passkeys)
- Secret-store weaknesses (encryption at rest, secret substitution through the
  fetch gateway)

Out of scope: vulnerabilities that only affect your own account's data, missing
best-practice headers without a demonstrated impact, and denial of service via
volume alone.

## Supported versions

Only the latest deployed version (the `main` branch) is supported. There are no
maintained release lines.

## Security model documentation

The authoritative record of the security invariants, threat model, and accepted
residual risks lives in
[docs/contributing/security.md](./docs/contributing/security.md).
