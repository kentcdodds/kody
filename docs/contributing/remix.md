# Remix guidance

Use the repo-local Remix skill instead of vendoring generated Remix package
documentation in this repository.

The current skill lives at:

- `.agents/skills/remix/SKILL.md`

Load that skill before changing Remix routes, controllers, middleware, data
access, validation, auth, sessions, file uploads, server setup, UI components,
hydration, navigation, or tests.

As of `remix@3.0.0-beta.0`, `npx remix@next new <app>` copies this skill from
the Remix CLI bootstrap template, but the standalone `remix skills install`
command is no longer exposed by the CLI.
