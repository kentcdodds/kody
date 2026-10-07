# Fail loudly at the right layer

Fail at the layer that can name the mistake and can still refuse the bad write.
A later quiet fallback hides which fact was missing.

## Example

A subscription wake cache is safe only when every manifest loaded.
`refreshPackageSubscriptionTopicMap` leaves the key missing on a partial scan:

```ts
if (scanned.manifestLoadFailures > 0) {
	// Leave the key missing so the next wake rescans rather than trusting
	// a partial map that dropped subscribers.
	return null
}
```

The next wake rescans
(`packages/worker/src/package-invocations/subscription-topic-cache.ts`).

## Related

- [Fix the root bottleneck](./fix-the-root-bottleneck.md)
