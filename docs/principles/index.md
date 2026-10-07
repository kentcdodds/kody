# Engineering principles

Short, durable rules for how we build Kody. Each page is one principle. Load
only the page the task needs.

| Principle                                                                   | When to open it                                                                                           |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [Generic platform](./generic-platform.md)                                   | Adding a vendor branch, a framework mount, or a provider-named type                                       |
| [Normalized source of truth](./normalized-source-of-truth.md)               | Adding a cache, index, or second store for a fact that already has a record                               |
| [Delete what is off the common path](./delete-off-the-common-path.md)       | Keeping a shim, flag, field, or doc for a path the product does not take                                  |
| [Cleanup](./cleanup.md)                                                     | A migration left the old lane beside the new one, or leftovers still name the old way                     |
| [Fail loudly at the right layer](./fail-loudly.md)                          | An error could be swallowed so a partial result continues                                                 |
| [Fix the root bottleneck](./fix-the-root-bottleneck.md)                     | Masking slowness with timeouts, fallbacks, or a quieter path                                              |
| [Two-way and one-way doors](./two-way-doors.md)                             | Deciding how much review a change needs                                                                   |
| [Examples over prose](./examples-over-prose.md)                             | Writing docs, skills, or a multi-step procedure                                                           |
| [Keep agent context lean](./lean-agent-context.md)                          | Editing `AGENTS.md`, agent skills, or deciding where guidance belongs                                     |
| [No invasive test-only code in production](./no-invasive-test-only-code.md) | Adding test seams, `*ForTests` exports, `NODE_ENV`/`VITEST` branches, or fixtures that would live in prod |
| [Test the workflow](./test-the-workflow.md)                                 | Adding or reshaping tests                                                                                 |

Related maps (not principles): [contributing index](../contributing/index.md),
[decision records](../contributing/decisions/index.md),
[harness engineering](../contributing/harness-engineering.md).
