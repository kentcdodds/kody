# Engineering principles

Short, durable rules for how we build Kody. Each page is one principle. Load
only the page the task needs.

| Principle                                                                   | When to open it                                                                                           |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [No invasive test-only code in production](./no-invasive-test-only-code.md) | Adding test seams, `*ForTests` exports, `NODE_ENV`/`VITEST` branches, or fixtures that would live in prod |
| [Keep agent context lean](./lean-agent-context.md)                          | Editing `AGENTS.md`, agent skills, or deciding where guidance belongs                                     |

Related maps (not principles): [contributing index](../contributing/index.md),
[decision records](../contributing/decisions/index.md),
[harness engineering](../contributing/harness-engineering.md).
