# Dependency auditing

Production-dependency vulnerability checks. See the [setup index](./index.md)
for the other setup pages.

- `npm run audit:prod` runs `npm audit --omit=dev --audit-level=moderate`.
  Moderate, high, and critical findings fail the command. Low findings do not.
- `npm run validate` and the CI static job (`.github/workflows/validate.yml`)
  run `audit:prod`. A green validate means production dependencies have no
  moderate-or-higher advisories.
- See [`docs/contributing/dependency-overrides.md`](../dependency-overrides.md)
  for `overrides` entries in the root `package.json` and their justifications.
