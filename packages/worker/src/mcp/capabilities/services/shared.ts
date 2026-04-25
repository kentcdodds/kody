import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { z } from 'zod'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	listSavedPackageServices,
	normalizePackageServiceStatus,
	packageServiceRpc,
	packageServiceStatusSchema,
} from '#worker/package-runtime/package-service.ts'

export { normalizePackageServiceStatus, packageServiceStatusSchema }

export const packageServiceRecordSchema = z.object({
	name: z.string(),
	entry: z.string(),
	auto_start: z.boolean(),
	timeout_ms: z.number().int().positive().nullable(),
})

export const packageServiceSummarySchema = packageServiceRecordSchema.extend({
	status: z.enum(['idle', 'running', 'stopping', 'stopped', 'error', 'unknown']),
})

function resolvePackageId(
	callerContext: McpCallerContext,
	explicitPackageId?: string | null,
) {
	const normalizedExplicit =
		typeof explicitPackageId === 'string' ? explicitPackageId.trim() : ''
	if (normalizedExplicit) {
		return normalizedExplicit
	}
	const appId = callerContext.storageContext?.appId?.trim() || ''
	if (appId) {
		return appId
	}
	throw new Error(
		'Package service APIs require package app or package job caller context.',
	)
}

export async function requirePackageServiceContext(input: {
	env: Env
	callerContext: McpCallerContext
	explicitPackageId?: string | null
	serviceName?: string | null
}) {
	const user = requireMcpUser(input.callerContext)
	const packageId = resolvePackageId(
		input.callerContext,
		input.explicitPackageId,
	)
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: user.userId,
		packageId,
	})
	if (!savedPackage) {
		throw new Error('Saved package was not found for package service operations.')
	}
	const serviceName = input.serviceName?.trim() || ''
	return {
		user,
		savedPackage,
		serviceName,
		service: serviceName
			? packageServiceRpc({
					env: input.env,
					userId: user.userId,
					packageId: savedPackage.id,
					kodyId: savedPackage.kodyId,
					sourceId: savedPackage.sourceId,
					baseUrl: input.callerContext.baseUrl,
					serviceName,
				})
			: null,
	}
}

export async function listPackageServicesForContext(input: {
	env: Env
	callerContext: McpCallerContext
	explicitPackageId?: string | null
}) {
	const context = await requirePackageServiceContext({
		env: input.env,
		callerContext: input.callerContext,
		explicitPackageId: input.explicitPackageId,
	})
	const listed = await listSavedPackageServices({
		env: input.env,
		userId: context.user.userId,
		baseUrl: input.callerContext.baseUrl,
		packageId: context.savedPackage.id,
		savedPackage: context.savedPackage,
	})
	return {
		savedPackage: context.savedPackage,
		rpc(serviceName: string) {
			return packageServiceRpc({
				env: input.env,
				userId: context.user.userId,
				packageId: context.savedPackage.id,
				kodyId: context.savedPackage.kodyId,
				sourceId: context.savedPackage.sourceId,
				baseUrl: input.callerContext.baseUrl,
				serviceName,
			})
		},
		services: listed.services.map((service) => ({
			name: service.name,
			entry: service.entry,
			auto_start: service.autoStart,
			timeout_ms: service.timeoutMs ?? null,
		})),
	}
}

export type PackageServiceStatusRecord = z.infer<
	typeof packageServiceStatusSchema
>

