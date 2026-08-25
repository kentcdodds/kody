# Dependency auditing

Production-dependency vulnerability checks. See the [setup index](./index.md)
for the other setup pages.

- `npm run audit:prod` checks production dependencies for known vulnerabilities
  (runs `npm audit --omit=dev`). This should return zero high or moderate
  findings before merging to `main`.
- See [`docs/contributing/dependency-overrides.md`](../dependency-overrides.md)
  for any `overrides` entries in the root `package.json` and their
  justifications.
