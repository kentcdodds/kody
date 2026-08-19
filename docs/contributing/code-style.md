# Code style

Apply these rules to all new or edited code. When in doubt, match the existing
file style first, then run the formatter.

## Function forms

- Prefer function declarations for named, reusable functions.
- Use arrow functions for callbacks and inline handlers.
- Use object method shorthand for multi-line object methods.

## Array types

- Prefer `Array<T>` and `ReadonlyArray<T>` over `T[]`.
- This avoids precedence pitfalls in union types and keeps type reads clearer.

## Exports

- Prefer named exports.
- Use default exports only when a framework contract requires them.

## Imports

- Prefer repo-root `#...` imports (configured via `package.json` `"imports"`)
  over parent-relative `../...` paths. Shared browser/server contracts use
  `#universal/*`.
- Keep `./...` imports for same-folder files.
- Generated files (for example `packages/worker/worker-configuration.d.ts`) are
  allowed to be exceptions; do not edit them by hand.

## Type conventions

- Prefer `type` aliases for object shapes and unions.
- Use `interface` only when you need declaration merging or public extension
  points.
- Prefer inline type definitions in parameters over named types unless sharing
  is necessary. When a one-off named type is useful, consider `Parameters<>` (or
  similar utility types) instead.
- Use `satisfies` when exporting objects that must match framework contracts.

## Accent borders

- An element with a solid accent border on one side (a callout's left bar, a
  status stripe) gets no border radius on that side; round only the corners
  facing away from the accent. A rounded corner dissolving into a straight
  accent bar is a design tell.
- For callouts, use `getAccentCalloutCss()` from
  `packages/worker/universal/styles/style-primitives.ts` instead of hand-rolling
  the pattern.

## Article breakout

- Articles and guides sit on `articleMeasure` (43rem). To let a block use more
  horizontal room when the viewport has it — code samples, transcripts — spread
  `getArticleBreakoutCss()` from the same primitives file into that child's css
  object. It stays a no-op on a phone and grows up to the header measure.

## Destructive actions

- Confirm first with `createDoubleCheck` from
  `packages/worker/client/double-check.ts` (second click, blur cancels).
- If the action should be undoable, apply the optimistic result and start
  `createUndoableAction` from `packages/worker/client/undoable-action.ts`.
  Render `UndoToast` while `pending` is set. `onCommit` is the real mutation
  (use `keepalive: true` on `fetch`); `onUndo` restores local state. Leaving the
  page commits so the action is not lost. Do not navigate to a remounting route
  during the undo window — remount commits immediately and loader data can
  restore the optimistic removal. Navigate after `onCommit` if the selection is
  gone.

## Absence values

- Use `null` for explicit "no value" in local state or API responses.
- Use `undefined` for optional or omitted fields, and avoid mixing within one
  API.

## References

- https://kentcdodds.com/blog/function-forms
- https://tkdodo.eu/blog/array-types-in-type-script
