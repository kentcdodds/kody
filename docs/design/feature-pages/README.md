# Feature pages

The production site has a `/features` overview and six native Remix detail
pages. Each detail page combines a hero, interactive examples, illustrated
product stories, documentation links, and an onboarding action. The briefs here
record the design direction and the evidence behind product claims.

| Route                    | Pitch                                         | Interaction                                                                           | Brief                             |
| ------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------- |
| `/features/memory`       | New agent. Same you.                          | Retrieve a saved preference in another agent and update it.                           | [Memory](./memory.md)             |
| `/features/secrets`      | Your agent can use the key. It can't read it. | Compare requests to approved and unapproved destinations.                             | [Secrets](./secrets.md)           |
| `/features/packages`     | Keep the software your agent builds.          | Inspect source and output, publish an example change, and compare access with a fork. | [Packages](./packages.md)         |
| `/features/triggers`     | Give the next step a starting signal.         | Follow an event through a package to a result, including a quiet result.              | [Triggers](./triggers.md)         |
| `/features/integrations` | Connect an account. Put it to work.           | Switch named accounts and reuse a connection through different packages.              | [Integrations](./integrations.md) |
| `/features/apps`         | Give your work a place to happen.             | Save, reopen, and edit a brief, then compare package access roles.                    | [Apps](./apps.md)                 |

## Implementation

- `packages/worker/universal/routes.ts` owns the public route paths.
- `packages/worker/client/routes/features.tsx` provides the route components and
  layout dimensions.
- `packages/worker/client/routes/features/` contains the overview, six detail
  components, and their supporting components and example data.
- `packages/worker/public/feature-pages.css` owns the shared visual styles,
  responsive layouts, theme colors, and reduced-motion behavior.
- `packages/worker/client/app.tsx` supplies the existing site header and footer.
  The pages use the site's light, dark, and system theme controls.
- `packages/worker/src/app/ssr-render-features.node.test.ts` checks the
  server-rendered feature pages.

Components use native Remix JSX, local state, and event handlers. Examples use
fictional data and identify themselves as examples or demos. Account selectors
do not change real connections, package publishing does not publish real code,
and the intake app keeps records only in the current page session. Documentation
and onboarding links lead to real site routes.

## Shared design

The pages use the six lantern colors, Bricolage Grotesque headlines, Wix Madefor
Text, warm neutral surfaces, and the existing matching orb artwork. Each orb
sits above its hero headline. The layouts follow the feature: memory is a saved
note, secrets shows a credential boundary, packages exposes source and output,
triggers follows an event, integrations distinguishes account identity from
package behavior, and apps offers a usable form.

Controls expose selected state in text as well as color. Reduced motion
preserves the story, and server-rendered copy and links remain available before
JavaScript loads. The overview gives each feature a compact example and a link
to its full story, plus a combined workflow showing how the capabilities fit
together.

## Product boundaries

- Memory belongs to an account. Cross-agent continuity does not mean shared
  organization memory or full conversation sync.
- Secrets resolve at an approved network boundary. The receiving API gets the
  credential, so this is not a claim that application behavior can never expose
  credentials.
- Packages have source and a current published commit. Use access includes
  source read and execution. Historic commits are not independently runnable
  versions.
- Triggers can dispatch ordinary code without model inference. A package may
  still call a model.
- Integrations supply authorization; packages supply operations. Some providers
  have built-in OAuth apps, while others require registering an app.
- Apps host Worker-compatible code with browser assets and package storage. A
  hosted URL does not establish anonymous public access or unrestricted Node
  hosting.

The six briefs retain supporting documentation, copy direction, audience
relevance, accessibility requirements, and claims to avoid. Search phrases are
intent hypotheses, not measured demand. The implemented components are the
source of truth for current copy and interactions.

## Research references

These sources informed category language and visual direction, not Kody product
claims or search-volume estimates:

- [Mem0, memory across agents](https://mem0.ai/library/agent-memory/how-memory-works-in-agent-to-agent-protocols)
- [Infisical, agent credential proxy](https://infisical.com/blog/agent-vault-the-open-source-credential-proxy-and-vault-for-agents)
- [Pipedream workflows](https://pipedream.com/workflows)
- [Pipedream integrations](https://pipedream.com/apps)
- [Trigger.dev](https://github.com/triggerdotdev/trigger.dev)
- [Executor feature demonstrations](https://executor.sh/#apps)
