# Guides

Official markdown guides for agent and contributor workflows. At runtime, the
**`kody_official_guide`** builtin capability loads these files from the `main`
branch via `raw.githubusercontent.com` (see capability description in code for
available `guide` ids).

| File                                                                           | Topic                                                                                                       |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| [integration-bootstrap.md](./integration-bootstrap.md)                         | **Start here** for third-party integrations that must work before saving a dependent package or package app |
| [secret-backed-integration.md](./secret-backed-integration.md)                 | Default recipe for non-OAuth integrations that use one or more saved secrets                                |
| [integration-backed-app-happy-path.md](./integration-backed-app-happy-path.md) | Default package app pattern after integration smoke test passes                                             |
| [package-service-pattern.md](./package-service-pattern.md)                     | General package-service pattern for native long-lived runtimes inside Kody                                  |
| [oauth.md](./oauth.md)                                                         | **Start here** for third-party OAuth (`/connect/oauth`, redirect URI, params)                               |
| [generated-ui-oauth.md](./generated-ui-oauth.md)                               | Edge case: OAuth in a hosted package app (`open_generated_ui` on a saved package)                           |
| [connect-secret.md](./connect-secret.md)                                       | `/connect/secret` URL parameters and policies                                                               |
