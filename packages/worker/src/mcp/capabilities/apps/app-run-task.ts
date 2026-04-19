import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { runAppTask } from '#worker/apps/service.ts'

const inputSchema = z.object({
	app_id: z.string().min(1).describe('Saved app id to execute.'),
	task_name: z
		.string()
		.min(1)
		.describe('Named task inside the saved app package to run.'),
	params: z
		.record(z.string(), z.unknown())
		.optional()
		.describe('Optional params passed to the app task.'),
})

const outputSchema = z.object({
	ok: z.boolean(),
	result: z.unknown().optional(),
	error: z.string().optional(),
	logs: z.array(z.string()).optional(),
})

export const appRunTaskCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'app_run_task',
		description:
			'Run a named task from a saved app package with execute-style codemode globals.',
		keywords: ['app', 'task', 'run', 'execute', 'codemode'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			return runAppTask({
				env: ctx.env,
				callerContext: ctx.callerContext,
				appId: args.app_id,
				taskName: args.task_name,
				params: args.params,
			})
		},
	},
)
