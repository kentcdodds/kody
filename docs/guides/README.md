# Guides

Official markdown guides for agent and contributor workflows. At runtime, the
**`coding_guide_get`** builtin capability loads these files from the `main`
branch via `raw.githubusercontent.com` (see capability description in code for
available `guide` ids).

| File                                                                                     | Topic                                                                                                                       |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [package-authoring.md](./package-authoring.md)                                           | General package-authoring guidance, including the README Intent section                                                     |
| [package-lifecycle.md](./package-lifecycle.md)                                           | Choose reuse, one-off execute, community fork when close, direct job schedules, or a new durable package                    |
| [integration-bootstrap.md](./integration-bootstrap.md)                                   | **Start here** for third-party integrations; after the smoke test, prefer a trusted community fork before building          |
| [openapi-integrations.md](./openapi-integrations.md)                                     | OpenAPI discover → summarize → scaffold or curated `openapi:<name>` binding                                                 |
| [secret-backed-integration.md](./secret-backed-integration.md)                           | Default recipe for non-OAuth integrations that use one or more saved secrets                                                |
| [integration-backed-app-happy-path.md](./integration-backed-app-happy-path.md)           | Default package app pattern after integration smoke test passes                                                             |
| [package-service-pattern.md](./package-service-pattern.md)                               | General package-service pattern for native long-lived runtimes inside Kody                                                  |
| [package-subscriptions.md](./package-subscriptions.md)                                   | Package subscription manifest shape, discovery, and email.message.received / email.system-message.received payload guidance |
| [platform-friction.md](./platform-friction.md)                                           | Agent self-improvement loop for Kody capability, package, memory, and guide friction                                        |
| [oauth.md](./oauth.md)                                                                   | **Start here** for third-party OAuth (`/connect/oauth`, redirect URI, params)                                               |
| [account-secret-setup.md](./account-secret-setup.md)                                     | `/account/secrets/new` URL parameters and policies                                                                          |
| [account-package-invocation-token-setup.md](./account-package-invocation-token-setup.md) | `/account/package-invocation-tokens/new` URL parameters and bearer-token safety policy                                      |
