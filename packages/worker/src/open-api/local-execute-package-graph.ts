import { z } from 'zod'
import { runWithRequestPermissions } from '#worker/authorization/authorize.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	buildLocalExecutePackageGraph,
	LocalExecutePackageGraphError,
} from '#worker/package-runtime/local-execute-package-graph.ts'
import { ApiError } from './errors.ts'
import {
	parseNativeInput,
	requireLocalExecuteHttpPrincipal,
	type NativeApiOperationDefinition,
} from './native-operation-helpers.ts'
import { type NativeApiOperationId } from './operations.ts'

export const localExecutePackageGraphInputSchema = z
	.object({
		code: z.string().min(1).max(512_000),
		imports: z.array(z.string().min(1).max(512)).max(64).optional(),
		conversationId: z.string().min(1).max(128).optional(),
	})
	.strict()

export const localExecutePackageGraphOutputSchema = z.object({
	modules: z.array(
		z.object({
			name: z.string().min(1),
			esModule: z.string(),
		}),
	),
	imports: z.array(z.string()),
	warnings: z.array(z.string()),
})

export type LocalExecutePackageGraphOperationId = Extract<
	NativeApiOperationId,
	'localExecutePackageGraph'
>

export const localExecutePackageGraphOperationDefinitions: Record<
	LocalExecutePackageGraphOperationId,
	NativeApiOperationDefinition
> = {
	localExecutePackageGraph: {
		summary: 'Download stamped package modules for local execute',
		description:
			'Resolve published, stamped `kody:@…` importable-module artifacts for an ad hoc execute module so `@kodycodes/cli execute --local` can embed them in workerd. Uses the same static-import scanner and resolution policy as cloud execute (packages resolve only in the caller org). Does **not** execute the user module and does not meter `dynamic_worker_day`. CapabilityProxy remains for per-call `kody:runtime` hops during the later local run. Requires `org:execute` and a scoped API token or CLI MCP OAuth bearer.',
		inputSchema: localExecutePackageGraphInputSchema,
		outputSchema: localExecutePackageGraphOutputSchema,
		readOnly: true,
		async handler(params, ctx) {
			requireLocalExecuteHttpPrincipal(ctx)
			const input = parseNativeInput(
				localExecutePackageGraphInputSchema,
				params,
			)
			try {
				return await runWithRequestPermissions(
					{ env: ctx.env, request: ctx.callerContext.request },
					() =>
						buildLocalExecutePackageGraph({
							env: ctx.env,
							baseUrl: ctx.callerContext.baseUrl,
							userId: ownerIdFromCaller(ctx.callerContext),
							code: input.code,
						}),
				)
			} catch (error) {
				throw toLocalExecutePackageGraphApiError(error)
			}
		},
	},
}

function toLocalExecutePackageGraphApiError(error: unknown): ApiError {
	if (error instanceof ApiError) return error
	if (error instanceof LocalExecutePackageGraphError) {
		return new ApiError({
			status: 400,
			code: error.code,
			message: error.message,
		})
	}
	throw error
}
