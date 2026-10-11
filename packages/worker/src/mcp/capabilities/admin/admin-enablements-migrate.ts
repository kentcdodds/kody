import { z } from 'zod'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	defaultEnablementBackfillDeps,
	runEnablementBackfill,
} from '#worker/enablements/backfill.ts'
import { enablementTriggerKinds } from '#worker/enablements/types.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const triggerKindSchema = z.enum(enablementTriggerKinds)

const plannedSchema = z.object({
	trigger_kind: triggerKindSchema,
	trigger_name: z.string(),
	instance_id: z.string(),
	package_id: z.string().nullable(),
	package_name: z.string().nullable(),
	enabler_user_id: z.string(),
	enabler_source: z.enum(['creator', 'earliest_owner']),
	unsigned_webhook: z.boolean(),
})

const orgReportSchema = z.object({
	org_id: z.string(),
	org_slug: z.string().nullable(),
	team_org: z.boolean(),
	state_before: z.enum(['legacy', 'notified', 'migrated']),
	outcome: z.enum(['planned', 'notified', 'migrated', 'skipped']),
	skip_reason: z
		.enum([
			'no_owner',
			'notice_required',
			'manifest_load_failed',
			'org_missing',
		])
		.nullable(),
	enablement_count: z.number().int().nonnegative(),
	planned: z.array(plannedSchema).optional(),
	notices: z.array(
		z.object({
			enabler_user_id: z.string(),
			recipient: z.string().nullable(),
			item_count: z.number().int().nonnegative(),
		}),
	),
})

const countByKindSchema = z.object({
	cron: z.number().int().nonnegative(),
	subscription: z.number().int().nonnegative(),
	webhook: z.number().int().nonnegative(),
})

export const adminEnablementsMigrateCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminEnablementsMigrate',
		description:
			'Admin-only migration auto-enable for the single enablement model: every existing job, webhook and subscription in an org not yet migrated becomes one enablement for a real member (creator if still a member, else the earliest Owner). dry-run writes nothing. notify emails team-org members which enablements will bill them and marks those orgs notified. apply writes enablements, generates signing secrets for unsigned webhooks, and marks orgs migrated (team orgs must be notified first). Pages over orgs by id. Audited.',
		keywords: [
			'admin',
			'enablements',
			'migration',
			'auto-enable',
			'jobs',
			'webhooks',
			'subscriptions',
			'billing notice',
		],
		destructive: true,
		inputSchema: z.object({
			mode: z
				.enum(['dry-run', 'notify', 'apply'])
				.describe('dry-run writes nothing. notify and apply write.'),
			org_ids: z
				.array(z.string().min(1))
				.min(1)
				.max(50)
				.optional()
				.describe('Limit the run to these org ids.'),
			cursor: z
				.string()
				.min(1)
				.optional()
				.describe('next_cursor from the previous page.'),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.describe('Orgs per page. Defaults to 25.'),
			include_planned: z
				.boolean()
				.optional()
				.describe(
					'Include each planned enablement per org. Defaults to false.',
				),
		}),
		outputSchema: z.object({
			mode: z.enum(['dry-run', 'notify', 'apply']),
			next_cursor: z.string().nullable(),
			totals: z.object({
				orgs_scanned: z.number().int().nonnegative(),
				orgs_by_outcome: z.object({
					planned: z.number().int().nonnegative(),
					notified: z.number().int().nonnegative(),
					migrated: z.number().int().nonnegative(),
					skipped: z.number().int().nonnegative(),
				}),
				team_orgs: z.number().int().nonnegative(),
				enablements_by_kind: countByKindSchema,
				unsigned_webhooks: z.number().int().nonnegative(),
				distinct_enablers: z.number().int().nonnegative(),
				notices_sent: z.number().int().nonnegative(),
			}),
			orgs: z.array(orgReportSchema),
		}),
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminEnablementsMigrate',
				async () => {
					const baseUrl = getAppBaseUrl({
						env: ctx.env,
						requestUrl: ctx.callerContext.baseUrl,
					})
					const report = await runEnablementBackfill({
						db: ctx.env.APP_DB,
						mode: args.mode,
						deps: defaultEnablementBackfillDeps({ env: ctx.env, baseUrl }),
						cursor: args.cursor ?? null,
						orgIds: args.org_ids,
						limit: args.limit,
					})
					return {
						mode: report.mode,
						next_cursor: report.nextCursor,
						totals: {
							orgs_scanned: report.totals.orgsScanned,
							orgs_by_outcome: report.totals.orgsByOutcome,
							team_orgs: report.totals.teamOrgs,
							enablements_by_kind: report.totals.enablementsByKind,
							unsigned_webhooks: report.totals.unsignedWebhooks,
							distinct_enablers: report.totals.distinctEnablers,
							notices_sent: report.totals.noticesSent,
						},
						orgs: report.orgs.map((org) => ({
							org_id: org.orgId,
							org_slug: org.orgSlug,
							team_org: org.teamOrg,
							state_before: org.stateBefore,
							outcome: org.outcome,
							skip_reason: org.skipReason,
							enablement_count: org.planned.length,
							...(args.include_planned
								? {
										planned: org.planned.map((item) => ({
											trigger_kind: item.triggerKind,
											trigger_name: item.triggerName,
											instance_id: item.instanceId,
											package_id: item.packageId,
											package_name: item.packageName,
											enabler_user_id: item.enablerUserId,
											enabler_source: item.enablerSource,
											unsigned_webhook: item.unsignedWebhook,
										})),
									}
								: {}),
							notices: org.notices.map((notice) => ({
								enabler_user_id: notice.enablerUserId,
								recipient: notice.recipient,
								item_count: notice.itemCount,
							})),
						})),
					}
				},
				{
					successReason: (result) =>
						`mode=${result.mode};orgs=${result.totals.orgs_scanned};migrated=${result.totals.orgs_by_outcome.migrated};notified=${result.totals.orgs_by_outcome.notified};notices=${result.totals.notices_sent}`,
				},
			)
		},
	},
)
