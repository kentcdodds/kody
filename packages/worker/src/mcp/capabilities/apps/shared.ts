import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { z } from 'zod'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'

export const packageRealtimeSessionRecordSchema = z.object({
	session_id: z.string(),
	facet: z.string(),
	topics: z.array(z.string()),
	connected_at: z.string(),
	last_seen_at: z.string(),
})

export const packageRealtimeTargetSchema = z.object({
	package_id: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional saved package id. Defaults to the caller package app/job when available.',
		),
	facet: z
		.string()
		.min(1)
		.optional()
		.describe('Optional facet name. Defaults to "main".'),
})

export const sessionEmitInputSchema = z.object({
	session_id: z.string().min(1),
	data: z.unknown(),
	package_id: z.string().min(1).optional(),
})

export const sessionEmitOutputSchema = z.object({
	delivered: z.boolean(),
	reason: z.string().optional(),
})

export const sessionBroadcastInputSchema = z.object({
	data: z.unknown(),
	topic: z.string().min(1).optional(),
	facet: z.string().min(1).optional(),
	package_id: z.string().min(1).optional(),
})

export const sessionBroadcastOutputSchema = z.object({
	ok: z.literal(true),
	package_id: z.string(),
	kody_id: z.string(),
	delivered_count: z.number(),
	session_ids: z.array(z.string()),
})

export type PackageRealtimeContext = {
	user: ReturnType<typeof requireMcpUser>
	savedPackage: NonNullable<
		Awaited<ReturnType<typeof getSavedPackageById>>
	>
	realtime: Awaited<ReturnType<typeof createPackageRealtimeClient>>
}

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
		'Package realtime APIs require package app or package job caller context.',
	)
}

export async function requirePackageRealtimeContext(input: {
	env: Env
	callerContext: McpCallerContext
	explicitPackageId?: string | null
}): Promise<PackageRealtimeContext> {
	const user = requireMcpUser(input.callerContext)
	const packageId = resolvePackageId(
		input.callerContext,
		input.explicitPackageId,
	)
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: user.userId,
		packageId,
	})
	if (!savedPackage || !savedPackage.hasApp) {
		throw new Error('Saved package app was not found for realtime operations.')
	}
	return {
		user,
		savedPackage,
		realtime: await createPackageRealtimeClient({
			env: input.env,
			userId: user.userId,
			packageId: savedPackage.id,
			kodyId: savedPackage.kodyId,
			sourceId: savedPackage.sourceId,
			baseUrl: input.callerContext.baseUrl,
		}),
	}
}

async function createPackageRealtimeClient(input: {
	env: Env
	userId: string
	packageId: string
	kodyId: string
	sourceId: string
	baseUrl: string
}) {
	const { packageRealtimeSessionRpc } = await import(
		'#worker/package-runtime/realtime-session.ts'
	)
	return packageRealtimeSessionRpc(input)
}
