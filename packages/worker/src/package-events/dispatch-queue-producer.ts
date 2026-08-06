export type PackageEventsDispatchQueueMessage = {
	userId: string
	topic: string
	idempotencyKey: string
	payload: Record<string, unknown>
	source: {
		packageId: string
		kodyId: string
	}
	/**
	 * Runtime invocation depth carried across the queue boundary so
	 * event-driven package chains (A emits, B's handler emits, ...) keep the
	 * same cycle protection as synchronous packages.invoke chains.
	 */
	invokeDepth: number
}

export function parsePackageEventsDispatchQueueMessage(
	body: unknown,
): PackageEventsDispatchQueueMessage | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const record = body as Record<string, unknown>
	const userId = record['userId']
	const topic = record['topic']
	const idempotencyKey = record['idempotencyKey']
	const payload = record['payload']
	const source = record['source']
	const invokeDepth = record['invokeDepth']
	if (
		typeof userId !== 'string' ||
		!userId.trim() ||
		typeof topic !== 'string' ||
		!topic.trim() ||
		typeof idempotencyKey !== 'string' ||
		!idempotencyKey.trim() ||
		!payload ||
		typeof payload !== 'object' ||
		Array.isArray(payload) ||
		!source ||
		typeof source !== 'object' ||
		Array.isArray(source) ||
		typeof invokeDepth !== 'number' ||
		!Number.isInteger(invokeDepth) ||
		invokeDepth < 0
	) {
		return null
	}
	const sourceRecord = source as Record<string, unknown>
	const packageId = sourceRecord['packageId']
	const kodyId = sourceRecord['kodyId']
	if (
		typeof packageId !== 'string' ||
		!packageId.trim() ||
		typeof kodyId !== 'string' ||
		!kodyId.trim()
	) {
		return null
	}
	return {
		userId: userId.trim(),
		topic: topic.trim(),
		idempotencyKey: idempotencyKey.trim(),
		payload: payload as Record<string, unknown>,
		source: { packageId: packageId.trim(), kodyId: kodyId.trim() },
		invokeDepth,
	}
}
