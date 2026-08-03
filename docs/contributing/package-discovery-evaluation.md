# Package discovery lifecycle evaluation

[`tools/evals/package-discovery-routing.json`](../../tools/evals/package-discovery-routing.json)
is a host/model evaluation for lifecycle behavior over a real Kody MCP
connection. Evaluated sessions receive only a case's natural-language `prompt`.
The inventory preconditions and `expected` actions remain with the evaluator.

The set has two cases for each scored route: reuse a discovered result, perform
one ephemeral execution, create a direct ad hoc job, and author durable reusable
source. It includes both one-time and simple recurring ad hoc schedules, plus a
scheduled workflow whose reusable interface and cross-host use justify durable
authoring.

## Account setup

Use the same disposable Kody account when comparing Warp, Cursor, Claude, and
ChatGPT. Do not use a production account: schedule and authoring cases mutate
state.

In a separate operator session, create the only required controlled fixture by
calling `value_set` through `execute` with:

```json
{
	"name": "project-updates",
	"value": "Checkout retry shipped; onboarding copy is in review; billing export is blocked on sample data.",
	"description": "Deterministic lifecycle evaluation fixture.",
	"scope": "user"
}
```

Before each controlled-inventory case, use a separate operator session to:

1. search for the task described by the case;
2. confirm there is no exact reusable result that already implements the whole
   task; and
3. remove jobs or saved source created by a prior run, or use a clean account.

Apart from `project-updates`, the one-off listing cases require no seeded data.
The `author-validated-cleanup-automation` prompt contains its validated source.
Run authoring cases last because they intentionally add searchable inventory.

The two `inventory-dependent` reuse cases are a separate cohort. Preflight them
against each host's Kody account using the case's `eligibility` rule. Run a case
only when exactly one eligible saved result exists; otherwise record
`skipped-no-eligible-match`. Do not count a skip as a pass or compare its reuse
rate across hosts. For deterministic reuse comparisons, provision all hosts with
the same disposable Kody account and the same eligible saved result before
running the case.

## Run in each host

Connect Kody using [Connect your agent](../use/connect-your-agent.md). In Warp,
Cursor, Claude, and ChatGPT:

1. Start a fresh session with Kody enabled and record the host and exact model.
2. Send only the case's `prompt`. Do not paste the case id, inventory metadata,
   expected route, action names, or this page into the evaluated session.
3. Allow the agent to use Kody and complete safe mutations requested by the
   prompt.
4. Export or copy the Kody `search` and `execute` call inputs and outputs before
   starting the next case.
5. Clean up created jobs or saved source from an operator session after its ids
   have been recorded. Delete the `project-updates` fixture after the suite.

This protocol evaluates MCP instructions and tool behavior. An answer with no
Kody trace fails because every non-skipped case requires discovery followed by
the appropriate action.

## Normalize the trace

Create one transcript event for every lifecycle action visible in a Kody tool
call. Preserve the actual tool input and output in `input` and `output`; redact
secrets, but do not replace tool names, entity ids, capability names, or source
metadata.

- A Kody `search` call is `search`. Record `exact-reusable` only when the result
  implements the whole task; supporting primitives are `no-exact-reusable`.
- Executing the exact discovered result is `invoke-existing`, with the same
  entity id recorded as `targetEntityId`.
- Ephemeral task code that does not persist source or a schedule is
  `execute-one-off`.
- An `execute` call to `job_schedule` or `job_schedule_once` is
  `schedule-ad-hoc-job`.
- Reading `coding_guide_get` or existing source before authoring is
  `inspect-authoring-guidance`.
- Initializing, editing, creating, or publishing reusable saved source is
  `author-package`. The scorer derives the phase from actual `execute` code:
  - `package_get_git_remote` and `repo_open_session` initialize an authoring
    lane;
  - `repo_write_file` and `repo_edit_files` are mutation-counted edit steps;
  - `repo_run_checks` is a check-only step and does not satisfy the required
    authoring mutation;
  - `package_save`, `package_publish_external_push`, and `repo_publish_session`
    create or publish source.
- Any other Kody `execute` call is `other-execute`, which no case allows.

If one `execute` call performs multiple lifecycle actions, emit one event per
action with the same `callId`, `input`, and `output`. This lets the scorer
reject an otherwise hidden extra schedule, execution, or authoring action.
Include failed tool attempts; the scorer fails traces containing them.

Every case requires discovery first. Up to three read-only `search` or
`inspect-authoring-guidance` actions are allowed so an agent can query, inspect
an entity, and load authoring guidance. Reuse, one-off execution, and ad hoc job
routes require exactly one terminal action.

Authoring may contain up to eight initialization, edit, check, create, and
publication events. It must include at least one mutation and end with an
`author-package` event whose `execute` code contains a recognized authoring
operation. Multiple publications are valid because safe rollout may publish a
disabled schedule, test it, and publish it enabled. Publication safety and
rollout correctness are outside this routing scorer's scope.

Repeated successful reuse invocations, one-off executions, or ad hoc schedules
still fail because those duplicate the terminal work selected by the route.

A transcript has this machine-readable shape:

```json
{
	"schemaVersion": 1,
	"evalName": "package-discovery-routing",
	"host": "cursor",
	"model": "model-name-and-version",
	"runAt": "2026-07-14T21:00:00.000Z",
	"results": [
		{
			"caseId": "one-off-saved-automation-count",
			"outcome": "completed",
			"events": [
				{
					"callId": "host-call-1",
					"action": "search",
					"toolName": "search",
					"status": "succeeded",
					"input": {},
					"output": {},
					"match": { "kind": "no-exact-reusable" }
				},
				{
					"callId": "host-call-2",
					"action": "execute-one-off",
					"toolName": "execute",
					"status": "succeeded",
					"input": {
						"code": "Actual captured execute module"
					},
					"output": {}
				}
			]
		}
	]
}
```

Inventory-dependent cases without an eligible result use:

```json
{
	"caseId": "reuse-recurring-email-drafter",
	"outcome": "skipped-no-eligible-match",
	"note": "Preflight found no eligible saved result."
}
```

## Score

Run the executable scorer:

```sh
node tools/evals/package-discovery-routing.ts score path/to/transcript.json
```

It validates the transcript, requires search first, verifies reuse targets match
discovery, checks `execute` source for the recorded lifecycle operations,
enforces route-aware action cardinality, rejects failed, duplicate, wrong,
hidden, or extraneous non-authoring terminal work, and reports
passed/failed/skipped totals per route. Read-only discovery and bounded
multi-step authoring may repeat. A controlled-inventory case cannot be skipped.
The process exits nonzero for invalid schemas or failed cases.

CI runs only the offline schema and scorer fixtures:

```sh
npx vitest run --project node-unit \
  tools/evals/package-discovery-routing.node.test.ts
```

CI does **not** connect to Warp, Cursor, Claude, ChatGPT, a model, or a live
Kody account, and therefore does not run or claim to pass the host/model
evaluation.

The scorer consumes this normalized format, not arbitrary host export formats.
The evaluator remains responsible for faithfully copying every raw Kody call and
splitting multi-action `execute` calls into events.
