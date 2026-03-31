# Execute and workflows

**execute** runs an async JavaScript function inside a sandbox. The sandbox
exposes **`codemode`** — one async method per **builtin capability name**
discovered through **search**.

## Shape of the code

The code must be an **async arrow function** that returns a value. Each
capability call takes one **args** object that matches that capability’s
**inputSchema** and returns data that matches its **outputSchema** when one
exists.

## Chaining

Prefer **one execute** when the plan is clear: call several capabilities in a
row, branch on results, and return the final structured result. Split into
multiple **execute** calls when you need new user input, confirmation, or a
result that changes the plan.

To read field shapes while coding, use **search** with
**`entity: "{name}:capability"`** for full schema detail for that capability.

## Saved skills

To run persisted user code by name, use **`meta_run_skill`** with **`name`** and
optional **`params`**. To inspect source, use **`meta_get_skill`**. You can also
inline saved skill code into **execute** when that fits the workflow.

## Network and OAuth helpers

The sandbox exposes **`fetch`**, secret placeholders in approved contexts,
**`refreshAccessToken(providerName)`**, and
**`createAuthenticatedFetch(providerName)`** for connector OAuth. See
[Secrets, values, and host approval](./secrets-and-values.md) for placeholders,
host approval, and **`codemode.secret_list`** / **`secret_set`**.

## Values

Readable non-secret configuration uses **`codemode.value_get`** and
**`codemode.value_list`** (for example data generated UI should persist).
