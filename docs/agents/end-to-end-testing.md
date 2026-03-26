# End-to-end testing principles

These notes summarize how we approach Playwright tests in this codebase, based
on the Epic Web E2E workshop and our existing setup.

## Goals

- Validate user-visible journeys end-to-end through the worker and client.
- Prefer a few high-signal tests over many brittle ones.
- Keep tests readable and close to how a user describes behavior.
- Keep the bar for adding an E2E test very high.

## What to test

- Only the most important happy-path user flows.
- Primary routes and flows that would make the product feel broken if they
  stopped working.
- Integration across the worker, client router, and API endpoints when that
  journey is central to the product.

Avoid testing implementation details, styling, or pure utility functions. Avoid
adding E2E coverage for edge cases, low-probability regressions, or bug fixes
that are unlikely to recur.

## Bar for adding a test

- Default to not adding a new E2E test.
- Add one only when the flow is both user-critical and hard to cover with faster
  tests.
- Prefer a single broad happy-path journey over multiple narrow regression
  cases.
- If a bug is unlikely to show up again, do not add an E2E test just to lock in
  the fix.

## Structure and style

- Keep tests flat: top-level `test(...)` with no `describe` nesting.
- Inline setup per test; avoid shared `beforeEach` unless required.
- Prefer one clear assertion per step and a small number of final assertions.
- Use Playwright’s `expect` and locator APIs (role/label/placeholder).

## Locators

Prefer stable, user-facing selectors:

- `getByRole` for buttons, links, headings, and inputs.
- `getByLabel` for form fields.
- `getByText` only for brief, stable copy.

Avoid `page.locator('css')` unless no accessible alternative exists.

## Server and routing

- The test server is started via Playwright `webServer` using Wrangler.
- `playwright.config.ts` is self-sufficient: Playwright starts the E2E server by
  running `npm run preview:e2e -- --port 3847`.
- `preview:e2e` prepares `packages/worker/.env`, builds the client bundles,
  applies local D1 migrations, and starts Wrangler against
  `.wrangler/state/e2e`.
- `npm run test:e2e`, `npm run test:e2e:ui`, and plain `npx playwright test` all
  use the same Playwright-native path.
- Playwright sets `CLOUDFLARE_ENV=test`; Wrangler still loads
  `packages/worker/.env` values for local secrets.
- Ensure the `env.test` section in `packages/worker/wrangler.jsonc` includes
  assets, KV, and durable objects since these are not inherited from top-level
  Wrangler config.
- Ensure `packages/worker/.env` includes a `COOKIE_SECRET` var for local
  sessions.
- Client routes live in `packages/worker/client/app.tsx` and
  `packages/worker/client/routes/index.tsx`.
- API endpoints are defined in `packages/worker/src/app/routes.ts` and mapped in
  `packages/worker/src/app/router.ts`.

When adding endpoints that accept bodies, ensure POST/PUT requests are not
handled by the static asset fetcher in `packages/worker/src/index.ts`.

## Test data

- Use real input values and a happy-path payload.
- Keep credentials and emails obviously fake and local-only.
- Avoid hidden fixtures or global state in the Playwright tests.

## Assertions

- Assert user-facing results (success message, redirect, visible element).
- For async actions, wait on the UI result, not arbitrary timeouts.
- For client-router regressions, you may set a `window` marker before clicking a
  link and assert it survives navigation to prove there was no full document
  reload.
- Use the same marker pattern for form submissions (for example logout) when
  verifying router-handled form navigation.

## Running tests

Common commands:

- `npm run test:e2e`
- `npm run test:e2e -- e2e/login.spec.ts`
- `npx playwright test`
- `npx playwright test e2e/login.spec.ts`

If `packages/worker/.env` is missing, the E2E server startup path copies
`packages/worker/.env.example` to `packages/worker/.env` before Wrangler starts.

These tests are executed by the `validate` gate, which also runs `lint:fix` and
the MCP E2E suite.
