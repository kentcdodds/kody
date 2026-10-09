# Normalized source of truth

Keep the fact in one normalized record. A derived map is a cache. The write path
invalidates that cache before readers can observe the new fact. A TTL is the
wrong invalidation when missing the new fact is worse than a rescan.

## Example

Subscription topics live on each package manifest. Wakes read one KV map. The
cache module states the rule:

```ts
 * The package manifest remains the only source of truth. This key is a cache of
 * that computed projection: wakes read one KV value instead of every saved
 * package's manifest.
```

`refreshPackageSubscriptionTopicMap` bumps a generation, deletes the map, then
recomputes
(`packages/worker/src/package-invocations/subscription-topic-cache.ts`).
`fillPackageSubscriptionTopicMapFromWakeScan` returns false when
`manifestLoadFailures > 0`.

## Related

- [Packages and manifests](../contributing/packages-and-manifests.md)
