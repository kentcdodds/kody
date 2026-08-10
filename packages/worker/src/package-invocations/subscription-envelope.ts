export const packageSubscriptionDispatchCapabilityName =
	'package_subscription_dispatch'

export const syntheticPackageSubscriptionSource = 'synthetic'

export const internalSyntheticSubscriptionTokenId =
	'internal:synthetic-subscriptions'

const syntheticSubscriptionDispatchBrand = Symbol(
	'synthetic-subscription-dispatch',
)

export type TrustedSyntheticSubscriptionDispatch = {
	readonly [syntheticSubscriptionDispatchBrand]: true
}

export const trustedSyntheticSubscriptionDispatch: TrustedSyntheticSubscriptionDispatch =
	Object.freeze({
		[syntheticSubscriptionDispatchBrand]: true,
	})

export function isTrustedSyntheticSubscriptionDispatch(
	value: TrustedSyntheticSubscriptionDispatch | undefined,
) {
	return value === trustedSyntheticSubscriptionDispatch
}

const untrustedSubscriptionEnvelopeFields = ['synthetic', 'replay_of'] as const

/**
 * Remove caller-controlled trust markers from subscription handler envelopes.
 * Real dispatch paths must strip these so handlers cannot be tricked into
 * treating forged events as platform-synthetic or replayed.
 */
export function stripUntrustedSubscriptionEnvelopeFields<
	T extends Record<string, unknown> | undefined,
>(params: T): T {
	if (!params) return params
	const stripped = { ...params }
	for (const field of untrustedSubscriptionEnvelopeFields) {
		delete stripped[field]
	}
	return stripped as T
}

export function buildPackageSubscriptionNotFoundMessage(input: {
	kodyId: string
	topic: string
}) {
	return `Package "${input.kodyId}" does not declare subscription "${input.topic}" in package.json#kody.subscriptions. Inspect handlers with package_subscriptions_list, or test dispatch with ${packageSubscriptionDispatchCapabilityName} once a handler is declared.`
}

/**
 * Fresh idempotency key for platform-synthetic subscription smoke tests.
 * Each call gets a new key so repeated dispatches exercise real side effects
 * instead of replaying a prior ledger row.
 */
export function buildFreshSyntheticSubscriptionIdempotencyKey() {
	return `synthetic:${crypto.randomUUID()}`
}

export function buildSubscriptionInvocationRunMetadata(input: {
	exportName: string
	isSubscription: boolean
	source: string | null
	topic: string | null
	params?: Record<string, unknown>
}) {
	const metadata: Record<string, unknown> = {
		exportName: input.exportName,
		source: input.source,
		topic: input.topic,
	}
	if (
		input.isSubscription &&
		input.source === syntheticPackageSubscriptionSource
	) {
		metadata.synthetic = true
		const replayOf = input.params?.['replay_of']
		if (typeof replayOf === 'string' && replayOf.trim().length > 0) {
			metadata.replay_of = replayOf.trim()
		}
	}
	return metadata
}
