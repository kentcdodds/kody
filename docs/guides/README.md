# Guides

Official markdown guides for agent and contributor workflows. At runtime, the
**`kody_official_guide`** builtin capability loads these files from the `main`
branch via `raw.githubusercontent.com` (see capability description in code for
available `guide` ids).

| File                                                   | Topic                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| [integration-bootstrap.md](./integration-bootstrap.md) | **Start here** for third-party integrations that must work before saving dependent skills or apps |
| [oauth.md](./oauth.md)                                 | **Start here** for third-party OAuth (`/connect/oauth`, redirect URI, params)                     |
| [generated-ui-oauth.md](./generated-ui-oauth.md)       | Edge case: OAuth in a saved app (`@kody/ui-utils`)                                                |
| [connect-secret.md](./connect-secret.md)               | `/connect/secret` URL parameters and policies                                                     |
