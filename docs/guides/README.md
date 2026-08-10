# Guides

Official markdown guides for agent and contributor workflows. Each guide carries
YAML frontmatter (`id`, `title`, `summary`, `category`, and for provider guides
`provider` and `lastVerified`). Sources live under `docs/guides/` and are
bundled into the worker at build time so every surface serves the same deployed
content:

- **`coding_guide_get`** over MCP — pass the stable `id` from frontmatter
- **`/guides`** on the web — browsable index and detail pages
- **Raw markdown** — `/guides/<slug>.md` or `Accept: text/markdown` on the
  detail route

## Platform guides

| File                                                                                     | Topic                                                                                                                          |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [what-is-kody.md](./what-is-kody.md)                                                     | Pre-account capability tour and discovery-interview notes; needs no account or MCP connection                                  |
| [first-win.md](./first-win.md)                                                           | **Start here** after a host authorizes: welcome email → reply from the personal inbox → memories → one-click integration       |
| [package-authoring.md](./package-authoring.md)                                           | General package-authoring guidance, including the README Intent section                                                        |
| [package-lifecycle.md](./package-lifecycle.md)                                           | Choose reuse, one-off execute, community fork when close, direct job schedules, or a new durable package                       |
| [integration-bootstrap.md](./integration-bootstrap.md)                                   | **Start here** for third-party integrations; after the smoke test, prefer a trusted community fork before building             |
| [openapi-integrations.md](./openapi-integrations.md)                                     | OpenAPI discover → summarize → scaffold or curated `openapi:<name>` binding (`openapi_integrations`)                           |
| [secret-backed-integration.md](./secret-backed-integration.md)                           | Default recipe for non-OAuth integrations that use one or more saved secrets                                                   |
| [integration-backed-app-happy-path.md](./integration-backed-app-happy-path.md)           | Default package app pattern after integration smoke test passes                                                                |
| [package-service-pattern.md](./package-service-pattern.md)                               | General package-service pattern for native long-lived runtimes inside Kody                                                     |
| [package-subscriptions.md](./package-subscriptions.md)                                   | Package subscription manifest shape, discovery, and email / repo lifecycle / run.error.recorded / admin topic payload guidance |
| [platform-friction.md](./platform-friction.md)                                           | Agent self-improvement loop for Kody capability, package, memory, and guide friction                                           |
| [oauth.md](./oauth.md)                                                                   | **Start here** for third-party OAuth (`/connect/oauth`, redirect URI, params)                                                  |
| [account-secret-setup.md](./account-secret-setup.md)                                     | `/account/secrets/new` URL parameters and policies                                                                             |
| [account-package-invocation-token-setup.md](./account-package-invocation-token-setup.md) | `/account/package-invocation-tokens/new` URL parameters and bearer-token safety policy                                         |

## Provider guides

Per-provider connect walkthroughs (`category: provider`). Load by MCP id or web
slug.

| File                                           | MCP id             | Web slug  |
| ---------------------------------------------- | ------------------ | --------- |
| [providers/discord.md](./providers/discord.md) | `provider_discord` | `discord` |
| [providers/github.md](./providers/github.md)   | `provider_github`  | `github`  |
| [providers/google.md](./providers/google.md)   | `provider_google`  | `google`  |
| [providers/notion.md](./providers/notion.md)   | `provider_notion`  | `notion`  |
| [providers/slack.md](./providers/slack.md)     | `provider_slack`   | `slack`   |
| [providers/spotify.md](./providers/spotify.md) | `provider_spotify` | `spotify` |
