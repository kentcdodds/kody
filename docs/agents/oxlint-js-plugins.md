# Oxlint JS plugin pattern

Use this repo's local plugin as the baseline pattern for custom oxlint rules.

## Files

- Plugin: `tools/oxlint/local-plugin.js`
- Plugin config: `tools/oxlint/oxlint-rules.json`
- Root config: `.oxlintrc.json`

## Pattern

1. Create a JS module that default-exports a plugin object.
2. Write rules with `createOnce` (alternative API) instead of `create`.
3. Keep rule metadata/rule names the same:
   - `meta.name` defines the rule namespace.
   - `rules` maps rule names to rule objects.
4. Add plugin paths and rule toggles in `tools/oxlint/oxlint-rules.json`.
5. Keep `.oxlintrc.json` stable by extending that file.
6. Enable rules using `<plugin-name>/<rule-name>`.

## Why this API here

This repo standardizes on Oxlint's alternative API (`createOnce`) for custom
rules. We are not targeting ESLint usage for these local plugins, so we keep
plugins Oxlint-only and do not include ESLint-compat helpers.

## Config layout

`.oxlintrc.json` should only contain shared/base extends plus a single extend to
`tools/oxlint/oxlint-rules.json`. Add or change custom JS plugins and local rule
settings in `tools/oxlint/oxlint-rules.json` so new rules do not require
touching root config.

## Example in this repo

- Plugin name: `kody-custom`
- Rule id: `no-example-identifier`
- Config key: `kody-custom/no-example-identifier`

The example rule reports when it finds the identifier
`__oxlint_plugin_example__`. This keeps the demo deterministic and avoids
accidentally linting normal production code.

## Verify manually

Create a temporary file containing the sentinel identifier and run:

```sh
bun run lint -- ./tmp-oxlint-plugin-rule-test.js
```

You should see a lint error from `kody-custom/no-example-identifier`.
Delete the temporary file after verification.

## References

- https://oxc.rs/docs/guide/usage/linter/js-plugins.html
