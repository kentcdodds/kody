# 0057 — No framework platform affordance for package bundles

- **Status:** accepted
- **Date:** 2026-10-04

## Context

Package publish and package-app bundling special-cased Remix: the platform
pre-bundled Workers-safe `remix/<subpath>` and `@remix-run/ui` into
`package-app-remix.mjs`, mounted them over `node_modules/` via
`withPlatformRemixFiles`, stamped `remixVersion` / `remixUiVersion` on published
bundle artifacts, rejected `@remix-run/*` npm dependencies, and treated a
declared `remix` dependency as inert. That trained agents to expect
platform-supplied frameworks and to add the next vendor the same way. Related
steering: [0054](./0054-no-vendor-specific-platform-logic.md).

## Decision

The platform has **no special affordance for any framework** in package bundles.
Do not vendor, mount, inject, sniff, or rewrite package graphs for Remix,
TanStack, Preact, or any other library. Packages that want a framework declare
and install it as an ordinary npm dependency. The origin UI may keep using Remix
for Kody's own app. Do not add a framework denylist or a generic "platform
libraries" mechanism — refuse supplying third-party modules the package snapshot
did not bring.

## Consequences

`withPlatformRemixFiles` / `loadPlatformRemixFiles` and writing `remixVersion` /
`remixUiVersion` artifact stamps are gone. Readers reject stored payloads that
still carry those stamps so injection-built artifacts stop serving, while
ordinary npm-backed v1 artifacts keep working without a forced republish.
Bundling asserts that `node_modules/` paths in the bundler file set already
exist in the package snapshot (`assertNoPlatformSuppliedNodeModules`). A
TanStack (or other framework) audit found no matching platform injection path —
only a docs mention of considering TanStack AI for origin, not package-app
injection. Do not invent one. Publish does not reject Remix or `@remix-run/*` as
special cases.

**Revisit-if** a Workers-only host primitive cannot be expressed as a package
dependency without breaking isolation, and the need is durable across many
packages (not one recipe).
