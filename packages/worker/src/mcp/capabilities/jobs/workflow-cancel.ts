import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

export const workflowCancelCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'workflow_run_cancel',
		description:
			'Cancel a Cloudflare Workflow run created through kody:runtime workflows.create by id. Terminates the underlying workflow instance and marks the run cancelled; cancelling an already-finished run is a safe no-op.',
		keywords: [
			'workflow',
			'cancel',
			'stop',
			'terminate',
			'abort',
			'kill',
			'halt',
			'background',
		],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema: z.object({
			id: z
				.string()
				.min(1)
				.describe(
					'Workflow run id from workflow_run_list or workflows.create output (dynwf-… inline runs or pkgwf-… package runs).',
				),
		}),
		outputSchema: z.object({
			id: z.string(),
			cancelled: z.boolean(),
			already_terminal: z.boolean(),
			status: z
				.enum([
					'queued',
					'running',
					'paused',
					'waiting',
					'waitingForPause',
					'unknown',
					'complete',
					'errored',
					'terminated',
					'cancelled',
				])
				.nullable(),
			message: z.string(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const { cancelWorkflowRunForUser } =
				await import('#worker/package-runtime/package-workflows.ts')
			const result = await cancelWorkflowRunForUser({
				env: ctx.env,
				userId: user.userId,
				workflowRunId: args.id,
			})
			switch (result.outcome) {
				case 'not_found':
					throw new Error(
						`Workflow run "${args.id}" was not found for the current user.`,
					)
				case 'already_terminal':
					return {
						id: result.run.id,
						cancelled: false,
						already_terminal: true,
						status: result.run.status,
						message: `Workflow run already finished with status "${result.run.status}"; cancellation is a no-op.`,
					}
				case 'cancelled':
					return {
						id: result.run.id,
						cancelled: true,
						already_terminal: false,
						status: result.run.status,
						message: 'Workflow run cancelled.',
					}
				default: {
					const exhaustive: never = result
					throw new Error(
						`Unhandled cancelWorkflowRunForUser outcome: ${JSON.stringify(exhaustive)}`,
					)
				}
			}
		},
	},
)
