import * as Sentry from '@sentry/cloudflare'

type WorkflowSentryPayload =
	| {
			sourceType: 'package'
			userId: string
			packageId: string
			kodyId: string
			sourceId: string
			workflowName: string
			exportName: string
			idempotencyKey: string
			runAt: string
			planDate: string | null
	  }
	| {
			sourceType: 'inline'
			userId: string
			packageContext: {
				packageId: string
				kodyId: string
				sourceId?: string | null
			} | null
			workflowName: string
			code: string
			idempotencyKey: string
			runAt: string
			planDate: string | null
	  }

/**
 * Attach identity + workflow coordinates so instrumentWorkflowWithSentry
 * auto-captures (timeouts, unhandled throws) are diagnosable without digging
 * through D1 breadcrumbs. High-cardinality ids stay on context, not tags.
 */
export function applyDynamicWorkflowSentryScope(input: {
	payload: WorkflowSentryPayload
	instanceId: string
}) {
	const { payload, instanceId } = input
	try {
		if (!Sentry.isInitialized()) return
		if (payload.userId) Sentry.setUser({ id: payload.userId })
		Sentry.setTag('workflow.source_type', payload.sourceType)
		if (payload.sourceType === 'package') {
			Sentry.setTag('workflow.kody_id', payload.kodyId)
		}
		Sentry.setContext('workflow', {
			instanceId,
			sourceType: payload.sourceType,
			workflowName: payload.workflowName,
			idempotencyKey: payload.idempotencyKey,
			runAt: payload.runAt,
			planDate: payload.planDate,
			...(payload.sourceType === 'package'
				? {
						packageId: payload.packageId,
						kodyId: payload.kodyId,
						sourceId: payload.sourceId,
						exportName: payload.exportName,
					}
				: {
						packageId: payload.packageContext?.packageId ?? null,
						kodyId: payload.packageContext?.kodyId ?? null,
						codeBytes: payload.code.length,
					}),
		})
	} catch {
		// Observability must never break workflow execution.
	}
}
