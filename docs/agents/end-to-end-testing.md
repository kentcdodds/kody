# End-to-end testing principles

These notes summarize how we approach Playwright tests in this codebase, based
on the Epic Web E2E workshop and our existing setup.

## Goals

- Validate user-visible journeys end-to-end through the worker and client.
- Prefer a few high-signal tests over many brittle ones.
- Keep tests readable and close to how a user describes behavior.

## What to test

- Primary routes and flows (navigation, auth, critical forms).
- Integration across the worker, client router, and API endpoints.
- Regressions that are expensive to catch in unit tests.

Avoid testing implementation details, styling, or pure utility functions.

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
- The base URL defaults to `http://localhost:8788` for Playwright to avoid
  colliding with the dev server. Override with `PLAYWRIGHT_BASE_URL` or
  `PLAYWRIGHT_PORT`.
- Playwright sets `CLOUDFLARE_ENV=test`; Wrangler still loads `.env` values for
  local secrets.
- Ensure the `env.test` section in `packages/worker/wrangler.jsonc` includes
  assets, KV, and durable objects since these are not inherited from top-level
  Wrangler config.
- Ensure `.env` includes a `COOKIE_SECRET` var for local sessions.
- Client routes live in `client/app.tsx` and `client/routes/index.tsx`.
- API endpoints are defined in `server/routes.ts` and mapped in
  `server/router.ts`.

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

- `bun run test:e2e`
- `bun run test:e2e e2e/login.spec.ts`

If `.env` is missing, `test:e2e` copies `.env.example` to `.env` before running
Playwright.

These tests are executed by the `validate` gate, which also runs `lint:fix` and
the MCP E2E suite.
