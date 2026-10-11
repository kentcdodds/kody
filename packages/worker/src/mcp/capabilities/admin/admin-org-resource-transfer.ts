import { z } from 'zod'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { runOrgResourceTransfer } from '#worker/org-transfer/apply.ts'
import { defaultOrgTransferEffects } from '#worker/org-transfer/effects.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const orgSchema = z.object({ id: z.string(), slug: z.string() })
const entryNameSchema = z.object({
	scope: z.string(),
	binding: z.string(),
	name: z.string(),
})

export const adminOrgResourceTransferCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminOrgResourceTransfer',
		description:
			'Admin-only: move every live resource of one org (packages, repos, sources, memories, secrets and values, integrations, OAuth apps, MCP servers, webhooks, package storage, package jobs, enablements) to another org. Email inboxes, usage history, run logs, billing, and the meter stay. dry-run reports the plan as counts and names, with clashes, blockers, and orphans. apply refuses on any clash or blocker, and on orphans unless skipOrphans (which leaves orphans out and deletes them). apply holds both orgs\u2019 write leases, writes an R2 backup of every touched row, re-seals credentials to the target, copies package storage, re-points everything in one D1 batch (package names become @<target>/<kody_id>), bumps both access epochs, and writes org audit events on both. Returns counts, names, and the backup key; never credential values. Follow with the owner-scope-follows-registry codemod so package sources import the new scope. Audited.',
		keywords: [
			'admin',
			'org',
			'transfer',
			'move resources',
			'team',
			'migration',
		],
		destructive: true,
		inputSchema: z.object({
			fromOrgId: z.string().min(1).describe('Source org id (orgs.id).'),
			toOrgId: z.string().min(1).describe('Target org id (orgs.id).'),
			mode: z
				.enum(['dry-run', 'apply'])
				.describe('dry-run writes nothing; apply moves.'),
			skipOrphans: z
				.boolean()
				.optional()
				.describe(
					'Leave rows whose parent no longer exists out of the move and delete them.',
				),
		}),
		outputSchema: z.object({
			mode: z.enum(['dry-run', 'apply']),
			applied: z.boolean(),
			from: orgSchema,
			to: orgSchema,
			counts: z.record(z.string(), z.number()),
			packages: z.array(
				z.object({
					id: z.string(),
					from_name: z.string(),
					to_name: z.string(),
				}),
			),
			repos: z.array(z.string()),
			secrets: z.array(entryNameSchema),
			values: z.array(entryNameSchema),
			integrations: z.array(z.string()),
			oauth_apps: z.array(z.string()),
			mcp_servers: z.array(z.string()),
			webhooks: z.array(z.object({ package: z.string(), name: z.string() })),
			jobs: z.array(z.string()),
			storages: z.array(z.object({ storage_id: z.string(), kind: z.string() })),
			orphans: z.array(
				z.object({ table: z.string(), key: z.string(), reason: z.string() }),
			),
			clashes: z.array(z.string()),
			blockers: z.array(z.string()),
			warnings: z.array(z.string()),
			backup_key: z.string().nullable(),
			storage_copies: z.array(
				z.object({
					storage_id: z.string(),
					kv_entries: z.number(),
					sql_rows: z.record(z.string(), z.number()),
				}),
			),
			leftovers: z.record(z.string(), z.number()),
			post_commit_warnings: z.array(z.string()),
		}),
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminOrgResourceTransfer',
				async () => {
					const actor = ctx.callerContext.user
					if (!actor) throw new Error('A signed-in admin is required.')
					const baseUrl = getAppBaseUrl({
						env: ctx.env,
						requestUrl: ctx.callerContext.baseUrl,
					})
					const result = await runOrgResourceTransfer({
						db: ctx.env.APP_DB,
						effects: defaultOrgTransferEffects({
							env: ctx.env,
							baseUrl,
							actor: {
								userId: actor.userId,
								username: actor.username ?? null,
							},
						}),
						actorUserId: actor.userId,
						fromOrgId: args.fromOrgId,
						toOrgId: args.toOrgId,
						mode: args.mode,
						skipOrphans: args.skipOrphans ?? false,
					})
					return {
						mode: result.mode,
						applied: result.applied,
						...result.summary,
						backup_key: result.backupKey,
						storage_copies: result.storage.map((copy) => ({
							storage_id: copy.storageId,
							kv_entries: copy.kvEntries,
							sql_rows: copy.sqlRows,
						})),
						leftovers: result.leftovers,
						post_commit_warnings: result.postCommitWarnings,
					}
				},
				{
					successReason: (result) =>
						`mode=${result.mode};from=${result.from.id};to=${result.to.id};packages=${result.packages.length};orphans=${result.orphans.length};clashes=${result.clashes.length};blockers=${result.blockers.length};backup=${result.backup_key ?? 'none'}`,
				},
			)
		},
	},
)
