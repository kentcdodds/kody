import { McpCallerError } from '#mcp/caller-error.ts'
import { getJoinedIntegrationByName } from './repo.ts'
import { normalizeIntegrationUsageMode } from './usage-mode.ts'

export class IntegrationPackageAccessDeniedError extends McpCallerError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'IntegrationPackageAccessDeniedError'
	}
}

export function buildIntegrationPackageApprovalUrl(input: {
	baseUrl: string
	name: string
	packageId: string
	kodyId?: string | null
}) {
	const url = new URL('/account/integrations/approve', input.baseUrl)
	url.searchParams.set('name', input.name)
	url.searchParams.set('package_id', input.packageId)
	if (input.kodyId) {
		url.searchParams.set('package', input.kodyId)
	}
	return url.toString()
}

export function createIntegrationPackageAccessDeniedMessage(input: {
	integrationName: string
	packageName: string
	approvalUrl: string
}) {
	return `Package "${input.packageName}" is not approved to use integration "${input.integrationName}". Approve it at ${input.approvalUrl}.`
}

export function createIntegrationExecuteAccessDeniedMessage(input: {
	integrationName: string
}) {
	return `Integration "${input.integrationName}" is limited to specific packages and cannot be used from execute. Approve a package from the account integrations page, or switch the integration back to any context.`
}

/**
 * `any` is execute plus every package. `packages` is only the listed ids —
 * execute (no packageId) is denied. Unlike user secrets, self-authored
 * packages do not auto-pass.
 */
export async function assertCanUseIntegration(input: {
	env: Pick<Env, 'APP_DB'>
	baseUrl: string
	userId: string
	name: string
	packageId?: string | null
	packageKodyId?: string | null
}): Promise<void> {
	const joined = await getJoinedIntegrationByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name: input.name,
	})
	if (!joined) return
	const usageMode = normalizeIntegrationUsageMode(joined.connection.usageMode)
	if (usageMode === 'any') return
	const packageId = input.packageId?.trim() ?? ''
	if (!packageId) {
		throw new IntegrationPackageAccessDeniedError(
			createIntegrationExecuteAccessDeniedMessage({
				integrationName: joined.connection.name,
			}),
		)
	}
	if (joined.connection.allowedPackageIds.includes(packageId)) return
	const approvalUrl = buildIntegrationPackageApprovalUrl({
		baseUrl: input.baseUrl,
		name: joined.connection.name,
		packageId,
		kodyId: input.packageKodyId,
	})
	throw new IntegrationPackageAccessDeniedError(
		createIntegrationPackageAccessDeniedMessage({
			integrationName: joined.connection.name,
			packageName: input.packageKodyId?.trim() || packageId,
			approvalUrl,
		}),
	)
}
