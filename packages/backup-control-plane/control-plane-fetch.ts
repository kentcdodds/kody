import { assertBackupDay } from '@kody-internal/shared/backup-staging.ts'

import {
	accessForbiddenResponse,
	assertSameOriginMutation,
	verifyAccessJwt,
} from './access-auth.ts'
import {
	BackupError,
	backupPayload,
	errorCode,
	isBackupEnabled,
	safeLog,
	workflowInstanceId,
} from './backup-policy.ts'
import { type BackupEnvironment } from './backup-types.ts'
import {
	htmlResponse,
	renderDashboard,
	renderDrillReport,
	renderEnqueueResult,
	renderMailboxPreDropStatusPage,
	renderMessagePage,
	renderRestoreAlreadyStartedPage,
	renderRestorePreparePage,
	renderRestoreStatusPage,
	renderSealResult,
} from './control-plane-ui.ts'
import { mailboxPreDropWorkflowInstanceId } from './mailbox-pre-drop-policy.ts'
import {
	restoreWorkflowInstanceId,
	validateSealedDayForRestore,
} from './production-restore.ts'
import {
	issueRestoreConfirmToken,
	verifyRestoreConfirmToken,
} from './restore-confirm-token.ts'
import { runRestoreDrill } from './restore-drill.ts'
import { sealFullBackupDay } from './seal-full-backup.ts'
import { enqueueBackup } from './workflow-trigger.ts'

async function readForm(request: Request): Promise<URLSearchParams> {
	const contentType = request.headers.get('content-type') ?? ''
	if (contentType.includes('application/x-www-form-urlencoded')) {
		return new URLSearchParams(await request.text())
	}
	if (contentType.includes('multipart/form-data')) {
		const form = await request.formData()
		const params = new URLSearchParams()
		for (const [key, value] of form.entries()) {
			if (typeof value === 'string') params.set(key, value)
		}
		return params
	}
	return new URLSearchParams(await request.text())
}

function requireDay(value: string | null): string {
	if (value === null || value.trim().length === 0) {
		throw new BackupError('invalid-day', 'day is required')
	}
	const day = value.trim()
	assertBackupDay(day)
	return day
}

function randomNonce(): string {
	return [...crypto.getRandomValues(new Uint8Array(16))]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

async function handleAuthenticated(
	request: Request,
	env: BackupEnvironment,
): Promise<Response> {
	const url = new URL(request.url)
	const path = url.pathname

	if (request.method === 'GET' && path === '/') {
		return htmlResponse(await renderDashboard(env))
	}

	if (request.method === 'GET' && path === '/restore-status') {
		const id = url.searchParams.get('id')
		if (!id) {
			return htmlResponse(
				renderMessagePage('Restore status', 'Missing workflow id.', {
					danger: true,
				}),
				400,
			)
		}
		try {
			const instance = await env.RESTORE_WORKFLOW.get(id)
			const status = await instance.status()
			const output =
				'output' in status ? (status as { output?: unknown }).output : undefined
			return htmlResponse(
				renderRestoreStatusPage({
					instanceId: id,
					status: status.status,
					progress:
						output && typeof output === 'object' ? (output as never) : null,
				}),
			)
		} catch (error) {
			return htmlResponse(
				renderMessagePage(
					'Restore status',
					`Unable to read workflow status: ${error instanceof Error ? error.message : 'unknown error'}`,
					{ danger: true },
				),
				404,
			)
		}
	}

	if (request.method === 'GET' && path === '/mailbox-pre-drop-status') {
		const id = url.searchParams.get('id')
		if (!id) {
			return htmlResponse(
				renderMessagePage(
					'Mailbox pre-drop backup status',
					'Missing workflow id.',
					{ danger: true },
				),
				400,
			)
		}
		try {
			const instance = await env.MAILBOX_PRE_DROP_BACKUP_WORKFLOW.get(id)
			const status = await instance.status()
			return htmlResponse(
				renderMailboxPreDropStatusPage({
					instanceId: id,
					status: status.status,
					receipt: 'output' in status ? status.output : undefined,
				}),
			)
		} catch {
			return htmlResponse(
				renderMessagePage(
					'Mailbox pre-drop backup status',
					'Unable to read the workflow instance.',
					{ danger: true },
				),
				404,
			)
		}
	}

	if (request.method !== 'POST') {
		return htmlResponse(
			renderMessagePage('Not found', 'Unknown route.', { danger: true }),
			404,
		)
	}

	assertSameOriginMutation(request)
	const form = await readForm(request)

	switch (path) {
		case '/actions/mailbox-pre-drop-backup': {
			if (!isBackupEnabled(env)) {
				throw new BackupError(
					'backup-disabled',
					'backups are disabled by enable gate',
				)
			}
			const backupRequest = {
				requestId: crypto.randomUUID(),
				nonce: randomNonce(),
				requestedAt: new Date().toISOString(),
			}
			const instanceId = mailboxPreDropWorkflowInstanceId(backupRequest)
			await env.MAILBOX_PRE_DROP_BACKUP_WORKFLOW.create({
				id: instanceId,
				params: backupRequest,
			})
			safeLog({
				event: 'ui-mailbox-pre-drop-backup',
				status: 'success',
				instanceId,
			})
			return htmlResponse(
				renderMailboxPreDropStatusPage({
					instanceId,
					status: 'queued',
				}),
			)
		}
		case '/actions/run-backup': {
			if (!isBackupEnabled(env)) {
				throw new BackupError(
					'backup-disabled',
					'backups are disabled by enable gate',
				)
			}
			const scheduledAt = new Date()
			const payload = backupPayload(env, scheduledAt)
			const result = await enqueueBackup(
				env.BACKUP_WORKFLOW,
				env.SOURCE_DATABASE_ID,
				payload,
			)
			safeLog({
				event: 'ui-run-backup',
				status: 'success',
				day: payload.day,
				instanceId: workflowInstanceId(env.SOURCE_DATABASE_ID, payload.day),
			})
			return htmlResponse(renderEnqueueResult(payload.day, result))
		}
		case '/actions/seal-day': {
			const day = requireDay(form.get('day'))
			const result = await sealFullBackupDay(env, day)
			switch (result.kind) {
				case 'sealed':
					safeLog({
						event: 'ui-seal-day',
						status: 'success',
						day,
						manifestKey: result.manifestKey,
					})
					return htmlResponse(
						renderSealResult(
							result.alreadySealed
								? `Day ${day} was already sealed at ${result.manifestKey}.`
								: `Sealed day ${day} at ${result.manifestKey}.`,
						),
					)
				case 'incomplete':
					safeLog({
						event: 'ui-seal-day',
						status: 'failure',
						day,
						errorCode: result.reason,
					})
					return htmlResponse(
						renderMessagePage(
							'Seal day incomplete',
							`Day ${day} is not ready to seal (${result.reason}).`,
							{ danger: true },
						),
						409,
					)
				default: {
					const exhaustive: never = result
					throw exhaustive
				}
			}
		}
		case '/actions/run-drill': {
			const day = requireDay(form.get('day'))
			const report = await runRestoreDrill(env, day)
			safeLog({
				event: 'ui-run-drill',
				status: report.errorCode === null ? 'success' : 'failure',
				day,
				errorCode: report.errorCode ?? undefined,
			})
			return htmlResponse(
				renderDrillReport(report),
				report.errorCode === null ? 200 : 500,
			)
		}
		case '/actions/restore/prepare': {
			const day = requireDay(form.get('day'))
			const validated = await validateSealedDayForRestore(env, day)
			const token = await issueRestoreConfirmToken(env, day)
			safeLog({
				event: 'ui-restore-prepare',
				status: 'success',
				day,
				manifestKey: validated.fullManifestKey,
			})
			return htmlResponse(
				renderRestorePreparePage({
					day,
					sourceDatabaseName: env.SOURCE_DATABASE_NAME,
					sqlObjectKey: validated.sqlObjectKey,
					sqlBytes: validated.sqlBytes,
					sqlSha256: validated.sqlSha256,
					token,
				}),
			)
		}
		case '/actions/restore/execute': {
			const day = requireDay(form.get('day'))
			const expiresAt = form.get('expiresAt') ?? ''
			const confirmToken = form.get('confirmToken') ?? ''
			const typedDatabaseName = form.get('typedDatabaseName') ?? ''
			await verifyRestoreConfirmToken(env, {
				day,
				expiresAt,
				token: confirmToken,
			})
			if (typedDatabaseName !== env.SOURCE_DATABASE_NAME) {
				throw new BackupError(
					'restore-name-mismatch',
					'typed database name does not match SOURCE_DATABASE_NAME',
				)
			}
			const instanceId = restoreWorkflowInstanceId(day, expiresAt)
			try {
				await env.RESTORE_WORKFLOW.create({
					id: instanceId,
					params: {
						day,
						requestedAt: new Date().toISOString(),
					},
				})
			} catch {
				let existing = false
				try {
					await env.RESTORE_WORKFLOW.get(instanceId)
					existing = true
				} catch {
					existing = false
				}
				if (existing) {
					safeLog({
						event: 'ui-restore-execute',
						status: 'failure',
						day,
						instanceId,
						errorCode: 'restore-already-started',
					})
					return htmlResponse(renderRestoreAlreadyStartedPage(instanceId), 409)
				}
				throw new BackupError(
					'restore-workflow-create-failed',
					'failed to start production restore workflow',
					true,
				)
			}
			safeLog({
				event: 'ui-restore-execute',
				status: 'success',
				day,
				instanceId,
			})
			return htmlResponse(
				renderRestoreStatusPage({
					instanceId,
					status: 'queued',
					progress: null,
				}),
			)
		}
		default:
			return htmlResponse(
				renderMessagePage('Not found', 'Unknown action.', { danger: true }),
				404,
			)
	}
}

export async function handleControlPlaneFetch(
	request: Request,
	env: BackupEnvironment,
	fetcher: typeof fetch = fetch,
): Promise<Response> {
	try {
		await verifyAccessJwt(env, request, fetcher)
	} catch (error) {
		safeLog({
			event: 'ui-auth-rejected',
			status: 'failure',
			errorCode: errorCode(error),
		})
		return accessForbiddenResponse(error)
	}

	try {
		return await handleAuthenticated(request, env)
	} catch (error) {
		safeLog({
			event: 'ui-action-failure',
			status: 'failure',
			errorCode: errorCode(error),
		})
		if (error instanceof BackupError && error.code === 'csrf-rejected') {
			return accessForbiddenResponse(error)
		}
		return htmlResponse(
			renderMessagePage(
				'Action failed',
				error instanceof Error ? error.message : 'unexpected error',
				{
					danger: true,
					details: error instanceof BackupError ? error.code : undefined,
				},
			),
			error instanceof BackupError ? 400 : 500,
		)
	}
}
