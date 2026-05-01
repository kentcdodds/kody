import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { invokePackageExport } from '#worker/package-invocations/service.ts'
import { buildPackageEventWorkflowId } from './package-event-workflow-id.ts'

export type PackageEventWorkflowParams = {
	userId: string
	packageId: string
	kodyId: string
	exportName: string
	workflowName: string
	eventKey: string
	planDate: string
	runAt: string
	params?: Record<string, unknown>
	source?: string
}

export type PackageEventWorkflowResult = {
	ok: true
	responseStatus: number
	bodyJson: string
}

const packageEventWorkflowSource = 'package-event-workflow'

function requireString(value: unknown, name: string) {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`Package event workflow requires ${name}.`)
	}
	return value.trim()
}

function normalizeWorkflowParams(
	params: PackageEventWorkflowParams,
): PackageEventWorkflowParams {
	const normalized = {
		userId: requireString(params.userId, 'userId'),
		packageId: requireString(params.packageId, 'packageId'),
		kodyId: requireString(params.kodyId, 'kodyId'),
		exportName: requireString(params.exportName, 'exportName'),
		workflowName: requireString(params.workflowName, 'workflowName'),
		eventKey: requireString(params.eventKey, 'eventKey'),
		planDate: requireString(params.planDate, 'planDate'),
		runAt: requireString(params.runAt, 'runAt'),
		params: params.params,
		source: params.source?.trim() || packageEventWorkflowSource,
	}
	const runAtMs = Date.parse(normalized.runAt)
	if (!Number.isFinite(runAtMs)) {
		throw new Error('Package event workflow requires runAt to be a valid date.')
	}
	return normalized
}

function millisecondsUntil(dateIso: string) {
	return Math.max(0, Date.parse(dateIso) - Date.now())
}

export class PackageEventWorkflow extends WorkflowEntrypoint<
	Env,
	PackageEventWorkflowParams
> {
	async run(
		event: WorkflowEvent<PackageEventWorkflowParams>,
		step: WorkflowStep,
	) {
		const params = normalizeWorkflowParams(event.payload)
		await step.sleep(
			'wait until package event time',
			millisecondsUntil(params.runAt),
		)
		return await step.do<PackageEventWorkflowResult>(
			'run package event export',
			{
				retries: {
					limit: 3,
					delay: '1 minute',
					backoff: 'exponential',
				},
				timeout: '5 minutes',
			},
			async () => {
				const response = await invokePackageExport({
					env: this.env,
					baseUrl: getAppBaseUrl({
						env: this.env,
						requestUrl: 'https://kody.local/package-event-workflow',
					}),
					token: {
						tokenId: packageEventWorkflowSource,
						userId: params.userId,
						email: '',
						displayName: `workflow:${params.kodyId}`,
						packageIds: [params.packageId],
						packageKodyIds: [params.kodyId],
						exportNames: [params.exportName],
						sources: [params.source ?? packageEventWorkflowSource],
					},
					request: {
						packageIdOrKodyId: params.packageId,
						exportName: params.exportName,
						params: params.params,
						idempotencyKey: buildPackageEventWorkflowId(params),
						source: params.source ?? packageEventWorkflowSource,
						topic: null,
					},
				})
				if (response.status >= 400) {
					throw new Error(
						`Package event workflow invocation failed with status ${response.status}: ${JSON.stringify(response.body)}`,
					)
				}
				return {
					ok: true,
					responseStatus: response.status,
					bodyJson: JSON.stringify(response.body),
				}
			},
		)
	}
}

export async function startPackageEventWorkflow(input: {
	env: Env
	params: PackageEventWorkflowParams
}) {
	const params = normalizeWorkflowParams(input.params)
	const id = buildPackageEventWorkflowId(params)
	const instance = await input.env.PACKAGE_EVENT_WORKFLOW.create({
		id,
		params,
	})
	return {
		id,
		instance,
	}
}
