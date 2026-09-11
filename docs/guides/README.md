# Docs sources

The markdown in this directory is the user-facing documentation served at
[kody.codes/docs](https://kody.codes/docs) and read by connected agents over
MCP. The directory keeps its historical `guides` name; the MCP entity type is
still `{id}:guide`. Each file carries YAML frontmatter (`id`, `title`,
`summary`, `category`, optional `audience`, `unadvertised`, `image` / `imageAlt`
/ `ogImage`, and for provider docs `provider` and `lastVerified`). Sources are
bundled into origin and `kody-platform` at build time so the web pages and
`search({ entity: "{id}:guide" })` serve the same deployed content. Doc-only
deploys upload those two scripts and skip runtime and jobs.

Surfaces:

- **`/docs`** — the introduction (`what-is-kody`) with the docs sidebar;
  `/docs/<slug>` for every other page. `/docs/connect` is the provider index.
- **Raw markdown** — `/docs/<slug>.md`, or `Accept: text/markdown` on the HTML
  URL. `/docs.md` is the introduction plus a sectioned index; `/llms.txt` (also
  `/docs/llms.txt`) is the compact index.
- **`search({ entity: "{id}:guide" })`** over MCP — pass the stable frontmatter
  `id` (for example `package_authoring:guide`). Oversized docs return a table of
  contents; open a heading with `{id}:guide#{slug}`.
- **Legacy `/guides*`** — every old URL 308s to its `/docs*` twin
  (`packages/worker/src/app/handlers/legacy-guides-redirect.ts`).

## Information architecture

Reading order, grouping, and short sidebar labels live in
[`packages/worker/universal/docs-nav.ts`](../../packages/worker/universal/docs-nav.ts).
Adding a doc means: drop the `.md` here, add one import + entry in
[`packages/worker/src/guides/catalog.ts`](../../packages/worker/src/guides/catalog.ts),
and place the slug in a `docsNav` section (or in `unadvertisedDocSlugs`). The
catalog throws at module scope when those three disagree. `connect` and
`llms.txt` are reserved path segments — do not use them as slugs.

Merging or renaming a doc: add the old slug to `legacyDocSlugAliases` and the
old MCP id to `legacyGuideIdAliases` in `docs-nav.ts` so old links, bookmarks,
and `search({ entity })` calls keep resolving.

Frontmatter `audience: agents` marks a playbook the connected agent follows step
by step (the page shows an "Agent playbook" label); omit it for ordinary
documentation.

| Section            | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Introduction       | [what-is-kody.md](./what-is-kody.md), [search-and-execute.md](./search-and-execute.md), [how-kody-works.md](./how-kody-works.md), [kody-factory.md](./kody-factory.md)                                                                                                                                                                                                                                                                               |
| Get started        | [connect-your-agent.md](./connect-your-agent.md), [onboarding.md](./onboarding.md), [quick-example.md](./quick-example.md), [portability.md](./portability.md), [first-win.md](./first-win.md)                                                                                                                                                                                                                                                       |
| Concepts           | [memory.md](./memory.md), [secrets.md](./secrets.md), [packages-integrations-mcp.md](./packages-integrations-mcp.md), [triggers.md](./triggers.md), [platform-efficiency.md](./platform-efficiency.md)                                                                                                                                                                                                                                               |
| Packages           | [package-lifecycle.md](./package-lifecycle.md), [package-authoring.md](./package-authoring.md), [package-sharing.md](./package-sharing.md), [package-apps.md](./package-apps.md), [package-subscriptions.md](./package-subscriptions.md), [heavy-work-offload.md](./heavy-work-offload.md)                                                                                                                                                           |
| Integrations       | [integration-bootstrap.md](./integration-bootstrap.md), [oauth.md](./oauth.md), [google-oauth.md](./google-oauth.md), [secret-backed-integration.md](./secret-backed-integration.md), [account-secret-setup.md](./account-secret-setup.md), [openapi-integrations.md](./openapi-integrations.md), [local-mcp-tunnels.md](./local-mcp-tunnels.md), [locked-mcp-server.md](./locked-mcp-server.md), [locked-gmail-drafts.md](./locked-gmail-drafts.md) |
| Connect a provider | [providers/](./providers/) — one file per provider (`category: provider`, alphabetical in the nav)                                                                                                                                                                                                                                                                                                                                                   |
| Help               | [platform-friction.md](./platform-friction.md)                                                                                                                                                                                                                                                                                                                                                                                                       |
| Unadvertised       | [values.md](./values.md), [account-package-invocation-token-setup.md](./account-package-invocation-token-setup.md) — reachable by exact slug / id only                                                                                                                                                                                                                                                                                               |

Wizard/checklist alignment for the Get started playbooks lives in
`packages/worker/universal/onboarding-process.ts` and is checked by
`onboarding-process.node.test.ts`.

## Provider docs

Per-provider connect walkthroughs (`category: provider`). Indexed on the web at
[`/docs/connect`](https://kody.codes/docs/connect) (markdown twin
`/docs/connect.md`). Load by MCP id or web slug; detail URLs stay under
`/docs/<slug>` (not nested under `/docs/connect/`).

| File                                                 | MCP id                | Web slug     |
| ---------------------------------------------------- | --------------------- | ------------ |
| [providers/discord.md](./providers/discord.md)       | `provider_discord`    | `discord`    |
| [providers/github.md](./providers/github.md)         | `provider_github`     | `github`     |
| [providers/google.md](./providers/google.md)         | `provider_google`     | `google`     |
| [providers/notion.md](./providers/notion.md)         | `provider_notion`     | `notion`     |
| [providers/origin.md](./providers/origin.md)         | `provider_origin`     | `origin`     |
| [providers/salesforce.md](./providers/salesforce.md) | `provider_salesforce` | `salesforce` |
| [providers/slack.md](./providers/slack.md)           | `provider_slack`      | `slack`      |
| [providers/spotify.md](./providers/spotify.md)       | `provider_spotify`    | `spotify`    |
