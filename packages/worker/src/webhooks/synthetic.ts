export const webhookSyntheticDispatchCapabilityName = 'webhookSyntheticDispatch'

const untrustedWebhookSyntheticFields = ['synthetic'] as const

/**
 * Remove caller-controlled trust markers from webhook export arguments.
 * Real ingress and synthetic MCP both strip these so handlers cannot be
 * tricked into treating forged fixtures as platform-synthetic.
 */
export function stripUntrustedWebhookSyntheticFields<
	T extends Record<string, unknown>,
>(params: T): T {
	const stripped = { ...params }
	for (const field of untrustedWebhookSyntheticFields) {
		delete stripped[field]
	}
	return stripped as T
}

/**
 * Fresh idempotency key for platform-synthetic webhook smoke tests.
 * Each call gets a new key so repeated dispatches exercise real side effects
 * instead of replaying a prior ledger row.
 */
export function buildFreshSyntheticWebhookIdempotencyKey() {
	return `synthetic:${crypto.randomUUID()}`
}

export function buildWebhookNotMintedMessage(input: {
	kodyId: string
	webhookName: string
}) {
	return `Webhook "${input.webhookName}" on package "${input.kodyId}" has not been minted. Call webhookUrlMint first, then smoke-test with ${webhookSyntheticDispatchCapabilityName}.`
}

export function buildWebhookInputModeMismatchMessage(input: {
	webhookName: string
	inputMode: 'request' | 'params'
	provided: 'request' | 'params'
}) {
	return `Webhook "${input.webhookName}" declares inputMode "${input.inputMode}". Provide a \`${input.inputMode}\` fixture (not \`${input.provided}\`) to ${webhookSyntheticDispatchCapabilityName}.`
}
