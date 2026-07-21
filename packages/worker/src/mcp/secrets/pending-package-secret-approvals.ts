import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	collectUserSecretRefsFromPackageSource,
	toSecretMountsFromUserRefs,
} from './collect-package-secret-refs.ts'
import { buildSecretPackageBulkApprovalUrlIfNeeded } from './package-approval-url.ts'
import { findMissingPackageApprovals } from './package-access.ts'
import { type SecretScope } from './types.ts'

export type PendingPackageSecretApproval = {
	secret_name: string
	approval_url: string
}

export type PendingPackageSecretApprovalsSummary = {
	package_id: string
	kody_id: string
	secrets: Array<PendingPackageSecretApproval>
	bulk_approval_url: string | null
}

export async function buildPendingPackageSecretApprovalsSummary(input: {
	env: Env
	baseUrl: string
	userId: string
	packageId: string
	kodyId: string
	secretMounts?: Record<
		string,
		{
			name: string
			scope?: SecretScope
		}
	> | null
	files?: Record<string, string> | null
	storageContext?: McpCallerContext['storageContext']
}): Promise<PendingPackageSecretApprovalsSummary | null> {
	const refs = collectUserSecretRefsFromPackageSource({
		secretMounts: input.secretMounts,
		files: input.files,
	})
	if (refs.length === 0) return null

	const storageContext = {
		sessionId: input.storageContext?.sessionId ?? null,
		appId: input.storageContext?.appId ?? null,
		packageId: input.storageContext?.packageId ?? input.packageId,
		storageId: input.storageContext?.storageId ?? null,
	}
	const missing = await findMissingPackageApprovals({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		packageId: input.packageId,
		mounts: toSecretMountsFromUserRefs(refs),
		storageContext,
	})
	if (missing.length === 0) return null

	const secrets = missing.map((entry) => ({
		secret_name: entry.secretName,
		approval_url: entry.approvalUrl,
	}))
	return {
		package_id: input.packageId,
		kody_id: input.kodyId,
		secrets,
		bulk_approval_url: buildSecretPackageBulkApprovalUrlIfNeeded({
			baseUrl: input.baseUrl,
			packageId: input.packageId,
			kodyId: input.kodyId,
			names: secrets.map((secret) => secret.secret_name),
		}),
	}
}

export function formatPendingPackageSecretApprovalsGuidance(
	summary: PendingPackageSecretApprovalsSummary,
) {
	const preferredUrl =
		summary.bulk_approval_url ?? summary.secrets[0]?.approval_url ?? null
	if (!preferredUrl) return ''
	const adoptOption = `either review the forked package source and call \`community_fork_adopt\` with a \`review_summary\` (user-secret read/use then works like a self-authored package), or`
	if (summary.secrets.length === 1) {
		return `Before treating this community-forked package as ready to run, ${adoptOption} send the user this package secret approval link and wait for approval: ${preferredUrl}. An ad hoc execute smoke test does not grant package secret access.`
	}
	return `Before treating this community-forked package as ready to run, ${adoptOption} send the user this bulk package secret approval link (one click for all listed secrets) and wait for approval: ${preferredUrl}. An ad hoc execute smoke test does not grant package secret access.`
}
