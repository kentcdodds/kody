import { z } from 'zod'
import { runWithRequestPermissions } from '#worker/authorization/authorize.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	buildLocalExecutePackageGraph,
	LocalExecutePackageGraphError,
	synthesizeLocalExecutePackageGraphEntry,
} from '#worker/package-runtime/local-execute-package-graph.ts'
import { ApiError } from './errors.ts'
import {
	parseNativeInput,
	requireLocalExecuteHttpPrincipal,
	type NativeApiOperationDefinition,
} from './native-operation-helpers.ts'
import { type NativeApiOperationId } from './operations.ts'
import { maxApiRequestBodyBytes } from './request-params.ts'

/**
 * Headroom under `maxApiRequestBodyBytes` for the JSON wrapper
 * (`{"code":"…","imports":[…],…}`) so a max-sized `code` does not 413 at the
 * edge body reader before Zod runs.
 */
const packageGraphCodeBodyOverheadBytes = 64 * 1024

/**
 * Inline `code` ceiling for package-graph. Capped just under the Open API JSON
 * body limit (`maxApiRequestBodyBytes`, 5 MiB) so the whole request still fits.
 * Publish allows larger repo source files via Artifacts git
 * (`maxRepoSourceFileBytes`, 10 MiB); callers with modules that large (or who
 * do not want to POST a multi-megabyte `kody dev` worker bundle) should pass
 * `imports` instead of inlining the whole bundle.
 */
export const maxLocalExecutePackageGraphCodeBytes =
	maxApiRequestBodyBytes - packageGraphCodeBodyOverheadBytes

const packageGraphImportsSchema = z.array(z.string().min(1).max(512)).max(64)

const packageGraphConversationIdSchema = z.string().min(1).max(128).optional()

const packageGraphCodeSchema = z
	.string()
	.min(1)
	.max(maxLocalExecutePackageGraphCodeBytes)

/**
 * `code` and/or `imports` (at least one). Union keeps OpenAPI `anyOf` branches
 * with required keys so the document does not advertise an empty optional body.
 */
export const localExecutePackageGraphInputSchema = z.union([
	z
		.object({
			code: packageGraphCodeSchema,
			imports: packageGraphImportsSchema.optional(),
			conversationId: packageGraphConversationIdSchema,
		})
		.strict(),
	z
		.object({
			imports: packageGraphImportsSchema,
			code: packageGraphCodeSchema.optional(),
			conversationId: packageGraphConversationIdSchema,
		})
		.strict(),
])

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
			'Resolve published, stamped `kody:@…` importable-module artifacts for an ad hoc execute module so `@kodycodes/cli execute --local` / `kody dev` can embed them in workerd. Uses the same static-import scanner and resolution policy as cloud execute (packages resolve only in the caller org). Pass inline `code` (up to just under the Open API JSON body limit of 5 MiB, leaving room for the JSON wrapper) and/or `imports`; when only `imports` is set, origin synthesizes a tiny entry so multi-megabyte worker bundles (TanStack / React apps) do not need to be posted. Does **not** execute the user module and does not meter `dynamic_worker_day`. CapabilityProxy remains for per-call `kody:runtime` hops during the later local run. Requires `org:execute` and a scoped API token or CLI MCP OAuth bearer.',
		inputSchema: localExecutePackageGraphInputSchema,
		outputSchema: localExecutePackageGraphOutputSchema,
		readOnly: true,
		async handler(params, ctx) {
			requireLocalExecuteHttpPrincipal(ctx)
			const input = parseNativeInput(
				localExecutePackageGraphInputSchema,
				params,
			)
			const code =
				input.code ??
				synthesizeLocalExecutePackageGraphEntry(input.imports ?? [])
			try {
				return await runWithRequestPermissions(
					{ env: ctx.env, request: ctx.callerContext.request },
					() =>
						buildLocalExecutePackageGraph({
							env: ctx.env,
							baseUrl: ctx.callerContext.baseUrl,
							userId: ownerIdFromCaller(ctx.callerContext),
							code,
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
