/**
 * Workflow run projections stored in the per-user RunLog Durable Object.
 *
 * Mirrors D1 `workflow_runs` (minus `user_id` — the DO identity is the user)
 * and adds the Cloudflare Workflow binding name so a user with multiple
 * bindings can be projected correctly. This is correctness state for
 * idempotency and concurrent-workflow entitlements; it must never be derived
 * from pruned run-history rows.
 */

import {
	activeWorkflowStatusValues,
	type WorkflowRunStatus,
} from '#worker/package-runtime/workflow-statuses.ts'

export type WorkflowProjectionSourceType = 'package' | 'inline'

export type WorkflowProjectionRecord = {
	id: string
	bindingName: string
	sourceType: WorkflowProjectionSourceType
	packageId: string | null
	kodyId: string | null
	sourceId: string | null
	workflowName: string
	exportName: string | null
	idempotencyKey: string
	runAt: string
	planDate: string | null
	status: string | null
	createdAt: string
	updatedAt: string
	completedAt: string | null
	lastError: string | null
}

export type WorkflowProjectionUpsertInput = {
	id: string
	bindingName: string
	sourceType: WorkflowProjectionSourceType
	packageId?: string | null
	kodyId?: string | null
	sourceId?: string | null
	workflowName: string
	exportName?: string | null
	idempotencyKey: string
	runAt: string
	planDate?: string | null
	status?: string | null
	createdAt?: string | null
	updatedAt?: string | null
	completedAt?: string | null
	lastError?: string | null
}

/** Mid-creation placeholder excluded from idempotency lookups (matches D1). */
export const creatingWorkflowProjectionStatus = 'creating'

export const workflowProjectionActiveStatuses: ReadonlyArray<string> =
	activeWorkflowStatusValues

export type { WorkflowRunStatus }
