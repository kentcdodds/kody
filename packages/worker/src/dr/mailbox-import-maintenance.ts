import {
	handleSecretMaintenanceRequest,
	MaintenanceFailureError,
} from '#worker/maintenance-handler.ts'
import {
	runMailboxImportTick,
	type MailboxImportConflictPolicy,
	type MailboxImportOwnerSelection,
} from '#worker/dr/mailbox-importer.ts'

function failure(message: string): MaintenanceFailureError {
	return new MaintenanceFailureError(message, {
		progress: null,
		warnings: [],
	})
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireExactNonEmptyString(value: unknown, field: string): string {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value !== value.trim()
	) {
		throw failure(`${field} must be an exact non-empty string`)
	}
	return value
}

function parseOwnerSelection(value: unknown): MailboxImportOwnerSelection {
	if (value === 'all-from-index') return value
	if (!Array.isArray(value) || value.length === 0) {
		throw failure('owners must be a non-empty array or "all-from-index"')
	}
	const owners = value.map((owner, index) =>
		requireExactNonEmptyString(owner, `owners[${index}]`),
	)
	if (new Set(owners).size !== owners.length) {
		throw failure('owners must not contain duplicates')
	}
	return owners
}

function assertExactRequestKeys(body: Record<string, unknown>) {
	const allowed = new Set([
		'conflictPolicy',
		'cursor',
		'day',
		'drill',
		'owners',
		'replaceConfirmation',
	])
	for (const key of Object.keys(body)) {
		if (!allowed.has(key)) throw failure(`unknown request field: ${key}`)
	}
}

export async function handleMailboxImportRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	return await handleSecretMaintenanceRequest({
		request,
		secret: env.DR_RESTORE_SECRET,
		notConfiguredMessage: 'Mailbox import is not configured',
		run: async () => {
			let body: Record<string, unknown>
			try {
				const value = (await request.json()) as unknown
				if (!isRecord(value)) throw new Error('body is not an object')
				body = value
			} catch {
				throw failure('Request body must be a JSON object')
			}
			assertExactRequestKeys(body)
			const day = requireExactNonEmptyString(body['day'], 'day')
			const owners = parseOwnerSelection(body['owners'])
			const conflictPolicy =
				body['conflictPolicy'] === undefined
					? undefined
					: body['conflictPolicy']
			if (
				conflictPolicy !== undefined &&
				conflictPolicy !== 'refuse' &&
				conflictPolicy !== 'replace'
			) {
				throw failure('conflictPolicy must be "refuse" or "replace"')
			}
			if (body['drill'] !== undefined && typeof body['drill'] !== 'boolean') {
				throw failure('drill must be a boolean')
			}
			if (
				body['replaceConfirmation'] !== undefined &&
				typeof body['replaceConfirmation'] !== 'string'
			) {
				throw failure('replaceConfirmation must be a string')
			}
			if (body['cursor'] !== undefined && typeof body['cursor'] !== 'string') {
				throw failure('cursor must be a string')
			}
			return await runMailboxImportTick({
				env,
				day,
				owners,
				conflictPolicy: conflictPolicy as
					| MailboxImportConflictPolicy
					| undefined,
				replaceConfirmation: body['replaceConfirmation'] as string | undefined,
				drill: body['drill'] as boolean | undefined,
				cursor: body['cursor'] as string | undefined,
			})
		},
	})
}
