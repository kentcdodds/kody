# Kody platform friction guide

Use this guide when Kody itself creates friction while you are using built-in
capabilities, saved packages, package apps, jobs, memories, values,
integrations, or official Kody guides.

The goal is small, user-approved self-improvement: reduce repeated friction
without turning the user's task into platform maintenance.

## What counts as Kody friction

Treat these as friction points:

- confusing or missing package README guidance
- a saved package whose intent or setup steps are unclear
- capability descriptions, schemas, or guide text that caused a wrong turn
- recurring user-specific preferences or workarounds that Kody could remember
- reproducible Kody bugs, misleading errors, or missing troubleshooting steps

Do not use this guide for normal product scope decisions, third-party API
failures, or credentials setup. Use `integration_bootstrap`, `oauth`, or
`connect_secret` for those workflows.

## Core rule

When you notice a Kody friction point and you can suggest a concrete
improvement, tell the user briefly and ask whether they want you to smooth it
out.

If the improvement is obvious, low-risk, and already within the work you are
doing, you may make it directly. Examples:

- fix a typo or stale setup step in a package README you are already editing
- clarify a package `## Intent` section after the user expanded the package
  scope
- add a missing usage note to package docs after you verified the behavior

Still mention the improvement in your final response so the user can see what
changed.

## Memory changes require approval

Ask before writing, updating, or deleting long-term memory.

Use memory only for durable user-specific facts, preferences, or repeated
workarounds. Do not store product bugs, transient task state, secrets, or raw
credentials as memory.

Before any memory mutation:

1. Explain the proposed memory in plain language.
2. Ask for user approval.
3. Run `meta_memory_verify`.
4. Only then run `meta_memory_upsert` or `meta_memory_delete` if the
   verification result supports the change.

## Package or docs improvements

When the friction is in a saved package or package-facing documentation:

1. Identify the smallest improvement that would have avoided the friction.
2. Prefer README, guide, or capability-description text over new primitives.
3. Make obvious, local documentation fixes when you are already modifying that
   package or repo.
4. Ask the user before changing package behavior, adding jobs, changing
   visibility, or broadening scope.

## Platform bugs and larger improvements

For Kody platform issues that you cannot fix in the current context:

1. Tell the user what went wrong and what workaround you used.
2. Suggest the smallest follow-up, such as a docs clarification, package update,
   or bug report.
3. Ask whether they want you to take that follow-up.

Keep this separate from the user's main task. Do not block a successful result
on filing a bug or improving docs unless the friction prevents completion.

## Suggested phrasing

Use concise language:

> I hit a Kody friction point: `<specific issue>`. A small improvement would be
> `<proposed fix>`. Would you like me to make that smoother?

For memory:

> This seems like a durable preference/workaround. I can propose a memory for
> it, but I will only write it after you approve.
