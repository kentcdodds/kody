# Package discovery routing evaluation

The repository-owned evaluation set at
[`tools/evals/package-discovery-routing.json`](../../tools/evals/package-discovery-routing.json)
checks whether an agent chooses the right lifecycle route after capability and
package discovery:

- reuse an existing capability or package
- prototype once with `execute`
- author a durable package

The cases cover recurring email drafting, a reusable writing style, a scheduled
workflow, cross-host reuse, and promotion of a successful script. Discovery
evidence is part of each case so every host and model receives the same
inventory state.

## Run the evaluation

Connect Kody to the host as described in
[Connect your agent](../use/connect-your-agent.md), then use the same procedure
in Warp, Cursor, Claude, and ChatGPT:

1. Record the host, model name/version, date, and evaluation `schemaVersion`.
2. Start a fresh conversation. Do not expose the case's `expected` object to the
   model.
3. Paste the top-level `instruction`, `routes`, and `reasonCodes`.
4. Paste `Discovery evidence:`, followed by the case's `discovery.summary`.
5. Paste `User prompt:`, followed by the case's `prompt`.
6. Save the returned JSON object and repeat in a fresh conversation for every
   case.

Use a fresh conversation for each case so earlier cases do not teach the model
the route labels. Use identical case content and model settings when comparing
hosts. The instruction prevents tool calls and mutations; this evaluation
measures routing, not live package inventory.

Agents can run the same protocol by reading the JSON, sending only
`instruction`, `routes`, `reasonCodes`, `discovery.summary`, and `prompt` to an
isolated host session, and recording the structured response. The set does not
require a repository checkout on the machine running the host.

## Score results

A case passes when:

1. the response is one JSON object;
2. `route` exactly equals `expected.route`;
3. `reasonCodes` contains every value in `expected.requiredReasonCodes`; and
4. every returned reason code occurs in the top-level `reasonCodes` registry.

Additional registered reason codes do not fail a case. Report both per-case
results and the aggregate passed/total count for each host/model pair. This
scores stable routing categories rather than matching explanatory prose.

The offline schema and coverage check runs with:

```sh
npx vitest run --project node-unit \
  tools/evals/package-discovery-routing.node.test.ts
```

It is also included in `npm run test` and therefore in `npm run validate`.

## Scope and limitations

This set isolates the post-discovery lifecycle decision. It does not measure
search ranking, MCP transport behavior, live inventory differences, quality of
generated package code, or whether a host honors a later mutation request. Those
concerns require separate integration evaluations. Add a case when it introduces
a distinct routing boundary; avoid adding paraphrases that exercise the same
boundary.
