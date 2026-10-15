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
 * Inline `code` ceiling for package-graph. Matches the Open API JSON body cap
 * (`maxApiRequestBodyBytes`, 5 MiB) — the same ceiling every other JSON Open
 * API operation already has. Publish allows larger repo source files via
 * Artifacts git (`maxRepoSourceFileBytes`, 10 MiB); callers with modules that
 * large (or who do not want to POST a multi-megabyte `kody dev` worker
 * bundle) should pass `imports` instead of inlining the whole bundle.
 */
export const maxLocalExecutePackageGraphCodeBytes = maxApiRequestBodyBytes

const packageGraphImportsSchema = z.array(z.string().min(1).max(512)).max(64)

export const localExecutePackageGraphInputSchema = z
	.object({
		/**
		 * Ad hoc / bundled module source to scan for static `kody:@…` imports.
		 * Optional when `imports` is provided (CLI `kody dev` large bundles).
		 */
		code: z
			.string()
			.min(1)
			.max(maxLocalExecutePackageGraphCodeBytes)
			.optional(),
		/**
		 * Explicit `kody:@…` import list. When `code` is omitted, origin
		 * synthesizes a tiny entry from these specifiers and resolves that.
		 * When `code` is present, origin still scans `code` (authoritative)
		 * and ignores this list for resolution — callers may still send it so
		 * older CLIs keep working.
		 */
		imports: packageGraphImportsSchema.optional(),
		conversationId: z.string().min(1).max(128).optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.code === undefined && value.imports === undefined) {
			ctx.addIssue({
				code: 'custom',
				message: 'Provide code and/or imports.',
				path: ['code'],
			})
		}
	})

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
			'Resolve published, stamped `kody:@…` importable-module artifacts for an ad hoc execute module so `@kodycodes/cli execute --local` / `kody dev` can embed them in workerd. Uses the same static-import scanner and resolution policy as cloud execute (packages resolve only in the caller org). Pass inline `code` (up to the Open API JSON body limit of 5 MiB) and/or `imports`; when only `imports` is set, origin synthesizes a tiny entry so multi-megabyte worker bundles (TanStack / React apps) do not need to be posted. Does **not** execute the user module and does not meter `dynamic_worker_day`. CapabilityProxy remains for per-call `kody:runtime` hops during the later local run. Requires `org:execute` and a scoped API token or CLI MCP OAuth bearer.',
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
