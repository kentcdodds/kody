import { z } from 'zod'
import {
	AdminMailboxMessageNotFoundError,
	adminMailboxMaintenanceRetentionMaxLimit,
	loadAdminMailboxMaintenanceStatus,
	runAdminMailboxMaintenanceDeleteMessage,
	runAdminMailboxMaintenanceRetention,
	runAdminMailboxMaintenanceSystemEmailGraphReconcile,
} from '#worker/admin/mailbox-maintenance.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	stableUserIdSchema,
} from './admin-shared.ts'

const retentionLimitSchema = z
	.number()
	.int()
	.min(1)
	.max(adminMailboxMaintenanceRetentionMaxLimit)
	.optional()
	.describe(
		`Optional owner page size (1–${adminMailboxMaintenanceRetentionMaxLimit}). Defaults to ${adminMailboxMaintenanceRetentionMaxLimit}.`,
	)

const mailboxCountSchema = z.object({
	threads: z.number().int().nonnegative(),
	messages: z.number().int().nonnegative(),
	attachments: z.number().int().nonnegative(),
	deliveryEvents: z.number().int().nonnegative(),
})

const outboundProviderIndexParitySchema = z.object({
	foreignKeyDetached: z
		.boolean()
		.describe(
			'True when the deployed provider-index schema has no message_id foreign key to legacy email_messages.',
		),
	indexCount: z
		.number()
		.int()
		.nonnegative()
		.describe('Rows in email_outbound_provider_index.'),
	distinctOwnerCount: z.number().int().nonnegative(),
	malformedCount: z.number().int().nonnegative(),
	parity: z
		.boolean()
		.describe('True when every thin index row is structurally valid.'),
})

const systemEmailGraphTableParitySchema = z.object({
	legacyCount: z.number().int().nonnegative(),
	dedicatedCount: z.number().int().nonnegative(),
	missingFromDedicatedCount: z.number().int().nonnegative(),
	missingFromLegacyCount: z.number().int().nonnegative(),
	ownershipMismatchCount: z.number().int().nonnegative(),
	referencedOwnerMismatchCount: z.number().int().nonnegative(),
	relationshipMismatchCount: z.number().int().nonnegative(),
	keyFieldMismatchCount: z.number().int().nonnegative(),
	parity: z.boolean(),
})

const systemEmailGraphParitySchema = z.object({
	threads: systemEmailGraphTableParitySchema,
	messages: systemEmailGraphTableParitySchema,
	attachments: systemEmailGraphTableParitySchema,
	deliveryEvents: systemEmailGraphTableParitySchema,
	outboundProviderIndex: z.object({
		legacyProviderLinkedMessageCount: z.number().int().nonnegative(),
		dedicatedProviderLinkedMessageCount: z.number().int().nonnegative(),
		legacyAuthorityIndexCount: z.number().int().nonnegative(),
		missingFromLegacyAuthorityIndexCount: z.number().int().nonnegative(),
		missingFromLegacyMessagesCount: z.number().int().nonnegative(),
		mismatchedLegacyAuthorityIndexCount: z.number().int().nonnegative(),
		classification: z.enum([
			'no-system-provider-links',
			'unsupported-system-provider-links',
		]),
		authorityDisposition: z.literal('dedicated-inbound-only'),
		parity: z.boolean(),
	}),
	parity: z.boolean(),
})

const statusSchema = z.object({
	generatedAt: z.string(),
	trackedOwners: z.number().int().nonnegative(),
	matching: z.number().int().nonnegative(),
	mismatch: z.number().int().nonnegative(),
	error: z.number().int().nonnegative(),
	incomplete: z.number().int().nonnegative(),
	eligible: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'Tracked owners meeting parity soak timing (matching_since age + fresh checked_at, zero mismatch/error). Does not require the read-cutover feature flag.',
		),
	oldestMatchingSince: z.string().nullable(),
	newestMatchingSince: z.string().nullable(),
	oldestCheckedAt: z.string().nullable(),
	newestCheckedAt: z.string().nullable(),
	earliestCutoverAt: z
		.string()
		.nullable()
		.describe(
			'Earliest matching_since + soak duration among matching owners, or null.',
		),
	outboundProviderIndex: outboundProviderIndexParitySchema.describe(
		'Fleet-wide aggregate D1 outbound provider reverse-index parity (counts only; no owner/message content).',
	),
	systemEmailGraph: systemEmailGraphParitySchema.describe(
		'Dedicated system-email authority versus the legacy rollback mirror. No email content is returned.',
	),
})

const systemEmailGraphMutationCountsSchema = z.object({
	threads: z.number().int().nonnegative(),
	messages: z.number().int().nonnegative(),
	attachments: z.number().int().nonnegative(),
	deliveryEvents: z.number().int().nonnegative(),
})

const systemEmailGraphReconcileMetricsSchema = z.object({
	upserted: systemEmailGraphMutationCountsSchema,
	deleted: systemEmailGraphMutationCountsSchema,
	referencedOwnerMismatchCount: z.number().int().nonnegative(),
})

const retentionMetricsSchema = z.object({
	mailbox: z.object({
		ownersAttempted: z.number().int().nonnegative(),
		ownersSucceeded: z.number().int().nonnegative(),
		ownersFailed: z.number().int().nonnegative(),
		before: mailboxCountSchema,
		after: mailboxCountSchema,
		blobDeleteFailureOwners: z.number().int().nonnegative(),
		expiredRemainingOwners: z.number().int().nonnegative(),
	}),
})

const deleteMessageResultSchema = z.object({
	authoritativeMessageAbsent: z
		.boolean()
		.describe('True when the authoritative message is gone after delete.'),
	attachmentsSeen: z
		.number()
		.int()
		.nonnegative()
		.describe('Attachment metadata rows captured at delete time.'),
	externalAttachmentsSeen: z
		.number()
		.int()
		.nonnegative()
		.describe('External-storage attachment rows captured at delete time.'),
	rawMimeBlobAbsent: z
		.boolean()
		.describe(
			'True when head() finds no object for every captured raw-MIME blob key.',
		),
	externalAttachmentBlobsAbsent: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'Count of captured attachment blob keys with no R2 object after delete.',
		),
	allCapturedBlobsAbsent: z
		.boolean()
		.describe(
			'True when every authoritative Mailbox or owner-fenced D1 fallback blob key is absent via head.',
		),
})

const inputSchema = z.discriminatedUnion('action', [
	z
		.object({
			action: z.literal('status'),
		})
		.strict(),
	z
		.object({
			action: z.literal('system_email_graph_reconcile'),
			force: z
				.literal(true)
				.describe(
					'Required acknowledgement that this rollback repair atomically rewrites the legacy mirror.',
				),
			direction: z
				.literal('dedicated_to_legacy')
				.describe(
					'Required safety fence: dedicated authority may repair legacy, never the reverse.',
				),
		})
		.strict(),
	z
		.object({
			action: z.literal('retention'),
			limit: retentionLimitSchema,
			start_after_user_id: stableUserIdSchema
				.optional()
				.describe(
					'Stable-user-id keyset cursor from a prior retention nextStartAfter. Ordered by stable_user_id ASC; never parity checked_at.',
				),
		})
		.strict(),
	z
		.object({
			action: z.literal('delete_message'),
			stable_user_id: stableUserIdSchema.describe(
				'Owning users.stable_user_id. Foreign or missing messages are rejected.',
			),
			message_id: z
				.string()
				.min(1)
				.describe('email_messages.id to delete for the given owner.'),
		})
		.strict(),
])

const outputSchema = z.discriminatedUnion('action', [
	z.object({
		action: z.literal('status'),
		status: statusSchema,
	}),
	z.object({
		action: z.literal('system_email_graph_reconcile'),
		metrics: systemEmailGraphReconcileMetricsSchema,
		postReport: systemEmailGraphParitySchema,
	}),
	z.object({
		action: z.literal('retention'),
		metrics: retentionMetricsSchema,
		nextStartAfter: stableUserIdSchema
			.nullable()
			.describe(
				'Pass as start_after_user_id on the next call when truncated is true.',
			),
		truncated: z
			.boolean()
			.describe(
				'True when more owners remain (full page) or the wall-clock budget stopped scheduling.',
			),
		status: statusSchema,
	}),
	z.object({
		action: z.literal('delete_message'),
		result: deleteMessageResultSchema,
	}),
])

export const adminMailboxMaintenanceCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'admin_mailbox_maintenance',
		description:
			'Admin-only Mailbox retention/delete maintenance and structural status: aggregate thin provider-index counts, dedicated system-email rollback-mirror parity, forced directional system_email_graph_reconcile, keyset-paged Mailbox retention (limit≤20; concurrency≤4; ~10s budget), or owner-scoped delete_message. USER shared-D1 parity/rebuild is retired and frozen graph tables are never queried. Audited.',
		keywords: [
			'admin',
			'mailbox',
			'maintenance',
			'parity',
			'provider-index',
			'system-email-graph',
			'reconcile',
			'retention',
			'delete',
			'cutover',
			'soak',
		],
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_mailbox_maintenance',
				async () => {
					switch (args.action) {
						case 'status': {
							const status = await loadAdminMailboxMaintenanceStatus({
								db: ctx.env.APP_DB,
							})
							return { action: 'status' as const, status }
						}
						case 'system_email_graph_reconcile': {
							const result =
								await runAdminMailboxMaintenanceSystemEmailGraphReconcile({
									db: ctx.env.APP_DB,
									direction: args.direction,
									force: args.force,
								})
							return {
								action: 'system_email_graph_reconcile' as const,
								metrics: result.metrics,
								postReport: result.postReport,
							}
						}
						case 'retention': {
							const result = await runAdminMailboxMaintenanceRetention({
								env: ctx.env,
								limit: args.limit,
								startAfterUserId: args.start_after_user_id,
							})
							return {
								action: 'retention' as const,
								metrics: result.metrics,
								nextStartAfter: result.nextStartAfter,
								truncated: result.truncated,
								status: result.status,
							}
						}
						case 'delete_message': {
							try {
								const result = await runAdminMailboxMaintenanceDeleteMessage({
									env: ctx.env,
									stableUserId: args.stable_user_id,
									messageId: args.message_id,
								})
								return { action: 'delete_message' as const, result }
							} catch (error) {
								// Missing/foreign canary targets are caller-supplied ids that
								// do not resolve — keep them off Sentry via McpCallerError.
								if (error instanceof AdminMailboxMessageNotFoundError) {
									throw new McpCallerError(error.message, { cause: error })
								}
								throw error
							}
						}
						default: {
							const exhaustive: never = args
							throw new Error(
								`Unhandled admin_mailbox_maintenance action: ${JSON.stringify(exhaustive)}`,
							)
						}
					}
				},
				{
					successReason: (result) => {
						switch (result.action) {
							case 'status':
								return `action=status;tracked=${result.status.trackedOwners};provider_index_parity=${result.status.outboundProviderIndex.parity ? 1 : 0};system_email_graph_parity=${result.status.systemEmailGraph.parity ? 1 : 0}`
							case 'system_email_graph_reconcile':
								return `action=system_email_graph_reconcile;upserted_messages=${result.metrics.upserted.messages};deleted_messages=${result.metrics.deleted.messages};owner_reference_mismatches=${result.metrics.referencedOwnerMismatchCount};parity=${result.postReport.parity ? 1 : 0}`
							case 'retention':
								return `action=retention;attempted=${result.metrics.mailbox.ownersAttempted};succeeded=${result.metrics.mailbox.ownersSucceeded};truncated=${result.truncated ? 1 : 0}`
							case 'delete_message': {
								const targetStableUserId =
									args.action === 'delete_message'
										? args.stable_user_id
										: 'unknown'
								const targetMessageId =
									args.action === 'delete_message' ? args.message_id : 'unknown'
								return `action=delete_message;stable_user_id=${targetStableUserId};message_id=${targetMessageId};authoritative_absent=${result.result.authoritativeMessageAbsent ? 1 : 0};blobs_absent=${result.result.allCapturedBlobsAbsent ? 1 : 0}`
							}
							default: {
								const exhaustive: never = result
								return `action=unknown;${JSON.stringify(exhaustive)}`
							}
						}
					},
				},
			)
		},
	},
)
