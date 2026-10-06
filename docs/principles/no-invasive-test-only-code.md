# No invasive test-only code in production

Production code must not carry invasive test-only seams. If the tests
disappeared, prod would not keep the code.

## Violations

- Branches that check `NODE_ENV`, `VITEST`, or `if (isTest)` only to change
  behavior under test
- Exported internals that exist only so tests can reach them (`__forTesting`,
  `_resetForTests`, `setXForTesting`, `__testOnly*`)
- Test-only parameters, options, or DI seams threaded through prod call
  signatures
- Mock or fake implementations that ship in the prod bundle
- Test-only env vars read by prod code
- Test-only routes or endpoints
- Timing hooks added purely for tests

## Prefer instead

- Exercise real behavior through public interfaces
- Real boundaries: a local service, miniflare/workerd, MSW at the network edge
- Fixtures and helpers that live in test files or `test-support/`

## Not violations

- Ordinary configuration prod uses too (feature flags, real env vars, URLs)
- Real dependency injection with a production purpose

## The test

Would production keep this if every test were deleted? If no, it does not belong
in prod.
