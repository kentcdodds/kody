import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import { authorizePackageWrite } from '#worker/authorization/authorize.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { buildPackageCapabilityApprovalUrl } from '#worker/package-capabilities/capability-approval-url.ts'
import { loadCapabilityApprovalSummary } from '#worker/package-capabilities/capability-approval-service.ts'
import {
	insertPackageSecurityAudit,
	packageSecurityAuditVerdicts,
} from '#worker/package-capabilities/security-audits-repo.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	packageSecurityAuditAnchor,
	packageSecurityAuditAuditorMaxLength,
	packageSecurityAuditSummaryMaxLength,
} from '#universal/package-security-audit-prompt.ts'

export const packageSecurityAuditRecordCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageSecurityAuditRecord',
		orgPermission: 'package:write',
		description:
			'Record an informational security audit for the exact published version of a saved package: its published commit plus capability-set fingerprint (both shown in the security audit prompt on the package capability approval page). Review that version first: declared vs used credentials, leaked secrets, unintended public exposure, risky network hosts, and package storage use. Then record verdict pass or concerns with a plain-language summary. The audit is tied to that commit and fingerprint; a new publish or changed capability set reads as not audited again. Recording an audit never approves capabilities or makes anything internet-visible; the owner still approves on the website.',
		keywords: [
			'package',
			'security',
			'audit',
			'review',
			'capabilities',
			'credentials',
			'secrets',
			'approval',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			package_id: z
				.string()
				.min(1)
				.describe('Saved package id that was audited.'),
			published_commit: z
				.string()
				.trim()
				.min(1)
				.describe(
					'Published commit SHA that was reviewed. Must match the package current published commit.',
				),
			fingerprint: z
				.string()
				.trim()
				.min(1)
				.describe(
					'Capability-set fingerprint that was reviewed. Must match the package current capability fingerprint.',
				),
			verdict: z
				.enum(packageSecurityAuditVerdicts)
				.describe(
					'`pass` when nothing concerning was found; `concerns` when the owner should look closer before approving.',
				),
			summary: z
				.string()
				.trim()
				.min(1)
				.max(packageSecurityAuditSummaryMaxLength)
				.describe(
					'Plain-language summary for the package owner: what was checked, what was found, and anything they should look at before approving. No secret values.',
				),
			auditor: z
				.string()
				.trim()
				.max(packageSecurityAuditAuditorMaxLength)
				.optional()
				.describe(
					'Optional name of the agent or person who performed the review, shown as "Audited by …". Defaults to the signed-in user.',
				),
		}),
		outputSchema: z.object({
			ok: z.literal(true),
			audit_id: z.string(),
			package_id: z.string(),
			published_commit: z.string(),
			fingerprint: z.string(),
			verdict: z.enum(packageSecurityAuditVerdicts),
			recorded_at: z.string(),
			audit_url: z.string(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request: requireMcpRequest(ctx.callerContext),
			})
			const savedPackage = await getSavedPackageById(ctx.env.APP_DB, {
				userId: owner.ownerUserId,
				packageId: args.package_id,
			})
			if (!savedPackage) {
				throw new McpCallerError('Saved package not found for this user.')
			}
			await authorizePackageWrite(
				{ env: ctx.env, request: ctx.callerContext.request },
				{
					id: savedPackage.id,
					userId: savedPackage.userId,
					label: savedPackage.name,
				},
			)
			const summary = await loadCapabilityApprovalSummary({
				env: ctx.env,
				ownerUserId: owner.ownerUserId,
				savedPackage,
				requestUrl: ctx.callerContext.baseUrl,
			})
			if (!summary.publishedCommit) {
				throw new McpCallerError(
					`"${savedPackage.name}" has no published version to audit. Publish it first, then audit the published commit.`,
				)
			}
			if (
				args.published_commit !== summary.publishedCommit ||
				args.fingerprint !== summary.capabilitySet.fingerprint
			) {
				throw new McpCallerError(
					`"${savedPackage.name}" changed since this audit started. The current published commit is ${summary.publishedCommit} and the capability fingerprint is ${summary.capabilitySet.fingerprint}. Re-audit the current version and record it with those values.`,
				)
			}

			const auditorLabel = args.auditor?.trim() || null
			const record = await insertPackageSecurityAudit(ctx.env.APP_DB, {
				id: crypto.randomUUID(),
				packageId: savedPackage.id,
				ownerUserId: owner.ownerUserId,
				publishedCommit: summary.publishedCommit,
				fingerprint: summary.capabilitySet.fingerprint,
				verdict: args.verdict,
				summary: args.summary,
				auditorLabel,
				recordedByUserId: owner.actorUserId,
				recordedAt: new Date().toISOString(),
			})
			await logAuditEvent({
				db: auditDatabaseFromEnv(ctx.env),
				category: 'account',
				action: 'package_security_audit_record',
				result: 'success',
				email: user.email,
				clientId: ctx.callerContext.oauthClientId ?? undefined,
				path: '/mcp',
				reason: [
					`package_id=${savedPackage.id}`,
					`published_commit=${record.publishedCommit}`,
					`fingerprint=${record.fingerprint}`,
					`verdict=${record.verdict}`,
					`audit_id=${record.id}`,
				].join(';'),
			})

			const approvalUrl = buildPackageCapabilityApprovalUrl({
				baseUrl: ctx.callerContext.baseUrl,
				username: owner.ownerScope,
				kodyId: savedPackage.kodyId,
			})
			return {
				ok: true as const,
				audit_id: record.id,
				package_id: record.packageId,
				published_commit: record.publishedCommit,
				fingerprint: record.fingerprint,
				verdict: record.verdict,
				recorded_at: record.recordedAt,
				audit_url: `${approvalUrl}#${packageSecurityAuditAnchor}`,
			}
		},
	},
)
