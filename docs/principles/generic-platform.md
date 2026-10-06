# Generic platform

Platform code exposes generic primitives. A package configures those primitives,
or it installs its own dependency. Vendor names and framework names stay out of
platform types, handlers, and bundle injection.

## Example

Webhook ownership quizzes are one type. Providers differ by knobs and documented
presets.

```ts
export const webhookChallengeTypeValues = ['subscription-challenge'] as const
```

`assertNoPlatformSuppliedNodeModules` refuses `node_modules/` paths the package
snapshot did not install. Remix and TanStack are ordinary package dependencies.

## Related

- [0054 No vendor-specific platform logic](../contributing/decisions/0054-no-vendor-specific-platform-logic.md)
- [0057 No framework platform affordance](../contributing/decisions/0057-no-framework-platform-affordance.md)
