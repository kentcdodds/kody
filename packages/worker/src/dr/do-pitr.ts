export const pitrUnavailableCode = 'pitr-unavailable'

export type DurableObjectPitrRpc = {
	getRecoveryBookmark: (input: {
		timestampMs: number
	}) => Promise<{ bookmark: string }>
	restoreToBookmark: (input: {
		bookmark: string
	}) => Promise<{ undoBookmark: string }>
}

type PitrStorage = {
	getBookmarkForTime?: (timestamp: number | Date) => Promise<string>
	onNextSessionRestoreBookmark?: (bookmark: string) => Promise<string>
}

type PitrContext = {
	storage: PitrStorage
	abort?: (reason?: string) => void
}

type PitrEnvironment = {
	SENTRY_ENVIRONMENT?: string
	WRANGLER_IS_LOCAL_DEV?: string
}

type PitrLogRecord = {
	event: 'do-pitr-restore-scheduled'
	objectKind: string
	targetBookmark: string
	undoBookmark: string
}

export class PitrUnavailableError extends Error {
	readonly code = pitrUnavailableCode

	constructor() {
		super(
			`${pitrUnavailableCode}: Durable Object point-in-time recovery is unavailable in this runtime.`,
		)
		this.name = 'PitrUnavailableError'
	}
}

function requirePitrMethod<Args extends Array<unknown>, Result>(
	method: ((...args: Args) => Result) | undefined,
): (...args: Args) => Result {
	if (typeof method !== 'function') throw new PitrUnavailableError()
	return method
}

function assertTimestampMs(timestampMs: number): number {
	if (!Number.isFinite(timestampMs) || !Number.isSafeInteger(timestampMs)) {
		throw new Error('timestampMs must be a finite safe integer.')
	}
	return timestampMs
}

function assertBookmark(bookmark: string): string {
	if (typeof bookmark !== 'string' || bookmark.trim().length === 0) {
		throw new Error('bookmark must be a non-empty string.')
	}
	return bookmark
}

function safeLogPitrRestore(
	record: PitrLogRecord,
	logger: Pick<Console, 'log'>,
): void {
	logger.log(JSON.stringify(record))
}

function assertPitrEnvironmentAvailable(
	environment: PitrEnvironment | undefined,
): void {
	if (
		environment?.WRANGLER_IS_LOCAL_DEV === 'true' ||
		environment?.SENTRY_ENVIRONMENT === 'test'
	) {
		throw new PitrUnavailableError()
	}
}

export async function getRecoveryBookmark(
	ctx: PitrContext,
	input: { timestampMs: number },
	options: { environment?: PitrEnvironment } = {},
): Promise<{ bookmark: string }> {
	assertPitrEnvironmentAvailable(options.environment)
	const getBookmarkForTime = requirePitrMethod(ctx.storage.getBookmarkForTime)
	const bookmark = await getBookmarkForTime.call(
		ctx.storage,
		assertTimestampMs(input.timestampMs),
	)
	return { bookmark }
}

/**
 * Queues a PITR restore and returns its only undo handle before resetting the
 * object. `ctx.abort()` cannot return an RPC value, so the reset is deferred to
 * the next task after the resolved RPC result has been handed to the runtime.
 */
export async function restoreToBookmark(
	ctx: PitrContext,
	input: { bookmark: string },
	options: {
		objectKind: string
		environment?: PitrEnvironment
		logger?: Pick<Console, 'log'>
		scheduleAbort?: (abort: () => void) => void
	},
): Promise<{ undoBookmark: string }> {
	assertPitrEnvironmentAvailable(options.environment)
	const onNextSessionRestoreBookmark = requirePitrMethod(
		ctx.storage.onNextSessionRestoreBookmark,
	)
	const abort = requirePitrMethod(ctx.abort)
	const targetBookmark = assertBookmark(input.bookmark)
	const undoBookmark = await onNextSessionRestoreBookmark.call(
		ctx.storage,
		targetBookmark,
	)
	safeLogPitrRestore(
		{
			event: 'do-pitr-restore-scheduled',
			objectKind: options.objectKind,
			targetBookmark,
			undoBookmark,
		},
		options.logger ?? console,
	)
	const scheduleAbort =
		options.scheduleAbort ??
		((reset: () => void) => {
			setTimeout(reset, 0)
		})
	scheduleAbort(() => {
		abort.call(ctx, 'Applying scheduled Durable Object PITR restore.')
	})
	return { undoBookmark }
}
