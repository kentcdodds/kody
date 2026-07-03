# Vendor tarballs

## connector-kit-1.2.0.tgz

Patched copy of `@kody-bot/connector-kit@1.2.0` with the restrictive
`engines.node: 24.x` field removed so installs on Node 26 do not emit
`EBADENGINE` warnings.

Remove this override once upstream publishes a release that supports Node 26.
