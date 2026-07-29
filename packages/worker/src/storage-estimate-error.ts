// Deliberately unanchored: transport layers can prefix/wrap this sentence, and
// execute error taxonomy must still recover the storage id and attempt count.
const storageEstimateReadErrorPattern =
	/Unable to verify the storage byte entitlement because the bucket estimate for storageId ("(?:\\.|[^"\\])*") could not be read after (\d+) attempts\./u

export type StorageEstimateReadErrorDetails = {
	storageId: string
	attempts: number
}

export function createStorageEstimateReadError(input: {
	storageId: string
	attempts: number
	cause: unknown
}) {
	return new Error(
		`Unable to verify the storage byte entitlement because the bucket estimate for storageId ${JSON.stringify(input.storageId)} could not be read after ${input.attempts} attempts.`,
		{ cause: input.cause },
	)
}

export function parseStorageEstimateReadErrorMessage(
	message: string,
): StorageEstimateReadErrorDetails | null {
	const match = storageEstimateReadErrorPattern.exec(message)
	if (!match) return null
	const serializedStorageId = match[1]
	const serializedAttempts = match[2]
	if (!serializedStorageId || !serializedAttempts) return null
	try {
		const storageId = JSON.parse(serializedStorageId) as unknown
		const attempts = Number(serializedAttempts)
		if (
			typeof storageId !== 'string' ||
			!Number.isSafeInteger(attempts) ||
			attempts < 1
		) {
			return null
		}
		return { storageId, attempts }
	} catch {
		return null
	}
}
