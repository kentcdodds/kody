# Remix guidance

Use the repo-local Remix skill instead of vendoring generated Remix package
documentation in this repository.

The repo-local skill lives at:

- `.agents/skills/remix/SKILL.md`

Load that skill before changing Remix routes, controllers, middleware, data
access, validation, auth, sessions, file uploads, server setup, UI components,
hydration, navigation, or tests.

`npx remix@next new <app>` copies this skill from the Remix CLI bootstrap
template. The CLI does not expose a standalone `remix skills install`
command.
