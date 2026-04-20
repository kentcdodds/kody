# Secret-backed integration recipe

Use this guide after `integration_bootstrap` when the integration uses one or
more saved secrets instead of an OAuth connector.

This is the default path for many automation-oriented integrations:

- API keys
- personal access tokens
- account IDs plus tokens
- static credentials that the user can copy from a provider dashboard

## Goal

Keep the integration flow simple:

1. research the provider's auth requirements
2. collect the required secret values through `/connect/secret`
3. run one real authenticated smoke test
4. only then build the downstream package or workflow

Do **not** jump straight to a generated UI or saved package if the secret and
smoke-test path is still unclear.

## Default recipe

1. Identify the provider's auth contract.
   - Confirm which fields are secrets and which are readable config.
   - Prefer the provider's native credential shape when possible.
   - If the API also needs readable configuration such as an account ID, base
     URL, region, workspace slug, or default sender, plan to store those as
     **values**, not secrets.
2. Check whether the needed secrets already exist.
   - Use `search` first for saved secret references.
   - Use `codemode.secret_list({})` inside `execute` only when you need the
     current runtime metadata.
3. If any secret is missing, stop and send the user to `/connect/secret`.
   - Ask for each missing secret by name.
   - Include the provider dashboard URL and short creation steps when helpful.
   - Do **not** ask the user to paste the secret into chat.
4. Wait for the user to confirm the secret is saved.
   - Do not treat the connect URL alone as completion.
5. Run one cheap authenticated smoke test in `execute`.
   - Use the same secret names and request shape the final package will use.
   - Prefer a small read-only endpoint such as account info, profile info, or a
     single-item list endpoint.
6. If the smoke test is blocked on host approval, stop.
   - Surface the approval link from the error.
   - Wait for the user to approve the host.
   - Retry only after approval.
7. After the smoke test passes, build the dependent package or workflow.
   - Prefer plain package exports for simple automations.
   - Use a package app only when the user actually needs interactive UI,
     browser-side forms, or hosted callbacks.

## Secret names and value names

Use descriptive, provider-agnostic-enough names that reflect the real auth
contract:

- good secret names:
  - `providerApiKey`
  - `providerAccessToken`
  - `providerAccountToken`
- good value names:
  - `providerAccountId`
  - `providerRegion`
  - `providerDefaultSender`

If the auth contract has multiple fields, save only the truly sensitive fields
as secrets. Keep readable identifiers and defaults in values.

## When `/connect/secret` is enough

In the common case, `/connect/secret` is the whole setup surface.

Use it when:

- the provider gives the user one or more static secret values
- the final request can use those secrets directly in `fetch(...)`
- the only extra work after saving the secret is host approval and a smoke test

This should be the default assumption for non-OAuth integrations.

## When to avoid generated UI

Generated UI is **not** the default integration path.

Do **not** build one just to:

- collect a normal API key or token
- collect an account ID or other readable config
- work around the need to ask the user for a secret through `/connect/secret`

Generated UI is the exception when the setup requires something
`/connect/secret` cannot express cleanly, such as:

- browser-side OAuth or hosted callback handling
- a provider-specific setup wizard with multiple non-secret choices
- a required transformation step that cannot be represented by saving the raw
  secret plus values directly

Even then, keep the UI focused on setup. The downstream package still waits for
the post-setup smoke test.

## Recommended chat phrasing

For a new secret-backed integration, the default response shape is:

1. state the auth requirement you found
2. ask the user to save the required secret or secrets through `/connect/secret`
3. say you will run a smoke test after they confirm setup
4. say you will build the package only after the smoke test passes

Example:

- \"This API uses an account ID plus a token. Please save `providerToken`
  through `/connect/secret`. I will use `providerAccountId` as a value, run a
  real authenticated smoke test, and then build the package.\"

## Anti-patterns

Avoid these mistakes:

- building a generated UI before checking whether `/connect/secret` is enough
- saving readable config as a secret
- saving the downstream package before the smoke test passes
- assuming a saved secret automatically approves outbound hosts
- inventing a provider-specific flow when one or two secrets plus a smoke test
  would do
