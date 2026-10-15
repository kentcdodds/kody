import {
	buildPackageSecurityAuditPrompt,
	packageSecurityAuditRecordHttpRoute,
	packageSecurityAuditRecordOperation,
} from '#universal/package-security-audit-prompt.ts'
import { loadCurrentPackageSecurityAudit } from './security-audit-state.ts'

/**
 * What an agent does next when a package moves toward internet-visible and
 * its current published version has no security audit. `args` holds the
 * exact values `packageSecurityAuditRecord` must receive; the agent adds
 * `verdict`, `summary`, and optionally `auditor`.
 */
export type PackageSecurityAuditNextStep = {
	nextStep: string
	operation: typeof packageSecurityAuditRecordOperation
	httpRoute: string
	args: {
		package_id: string
		published_commit: string
		fingerprint: string
	}
	auditPrompt: string
}

export function buildPackageSecurityAuditNextStep(input: {
	packageId: string
	packageName: string
	publishedCommit: string
	fingerprint: string
	approvalUrl: string
}): PackageSecurityAuditNextStep {
	return {
		nextStep: `No security audit is recorded for the published version of ${input.packageName}. Before handing the owner the approval link, audit published commit ${input.publishedCommit}, record the result with ${packageSecurityAuditRecordOperation} (args below plus verdict and summary), then send the owner ${input.approvalUrl}. The audit is informational; the owner still approves on that page.`,
		operation: packageSecurityAuditRecordOperation,
		httpRoute: packageSecurityAuditRecordHttpRoute(input.packageId),
		args: {
			package_id: input.packageId,
			published_commit: input.publishedCommit,
			fingerprint: input.fingerprint,
		},
		auditPrompt: buildPackageSecurityAuditPrompt(input),
	}
}

/** Null when the current published version already has an audit. */
export async function loadPackageSecurityAuditNextStep(input: {
	db: D1Database
	ownerUserId: string
	packageId: string
	packageName: string
	publishedCommit: string
	fingerprint: string
	approvalUrl: string
}): Promise<PackageSecurityAuditNextStep | null> {
	const audit = await loadCurrentPackageSecurityAudit(input.db, input)
	if (audit) return null
	return buildPackageSecurityAuditNextStep(input)
}
