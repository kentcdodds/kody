import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { createInvite, normalizeInviteCode } from '#worker/invites.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	planNameSchema,
	resolveActingAdminUserId,
} from './admin-shared.ts'
import {
	adminInviteCreatedSchema,
	type AdminInviteCreated,
	toCreatedInviteMetadata,
} from './admin-invite-shared.ts'

const bulkInviteItemSchema = z.object({
	code: z
		.string()
		.min(1)
		.describe('Custom invite code. Normalized to uppercase.'),
	note: z
		.string()
		.optional()
		.describe(
			'Optional operator note for this code. Falls back to the shared note when omitted.',
		),
})

const inputSchema = z.object({
	code: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional custom invite code. Normalized to uppercase. When omitted, Kody generates a random KODY-... code. Do not pass this together with codes.',
		),
	note: z
		.string()
		.optional()
		.describe(
			'Optional operator note stored with the invite. Not shown to invitees. Shared default for bulk items that omit their own note.',
		),
	maxUses: z
		.number()
		.int()
		.min(1)
		.default(1)
		.describe(
			'Maximum number of successful signups this invite can grant. Defaults to 1.',
		),
	expiresAt: z
		.string()
		.optional()
		.describe(
			'Optional ISO-8601 expiration timestamp. After this time the code cannot be consumed.',
		),
	plan: planNameSchema
		.optional()
		.describe(
			'Optional plan granted to accounts that sign up with this invite. Defaults to free.',
		),
	codes: z
		.array(bulkInviteItemSchema)
		.min(1)
		.max(200)
		.optional()
		.describe(
			'Optional bulk create. Shared maxUses, expiresAt, and plan apply to every item. Prefer this for launch batches instead of looping single creates.',
		),
})

const failedInviteSchema = z.object({
	code: z.string(),
	error: z.string(),
})

const outputSchema = z.object({
	invite: adminInviteCreatedSchema,
	invites: z.array(adminInviteCreatedSchema),
	failed: z.array(failedInviteSchema),
})

function parseExpiresAt(value: string | undefined) {
	if (!value?.trim()) return null
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) {
		throw new McpCallerError('expiresAt must be a valid date.')
	}
	return date.toISOString()
}

function toInviteCreateError(error: unknown, code?: string) {
	const message =
		error instanceof Error ? error.message : 'Unable to create invite.'
	if (/already exists/i.test(message)) {
		return new McpCallerError(message, {
			cause: error instanceof Error ? error : undefined,
		})
	}
	return new McpCallerError(code ? `${message} (${code})` : message, {
		cause: error instanceof Error ? error : undefined,
	})
}

function resolveCreateItems(args: {
	code?: string
	note?: string
	codes?: Array<{ code: string; note?: string }>
}) {
	if (args.codes) {
		if (args.code) {
			throw new McpCallerError('Provide either code or codes, not both.')
		}
		return args.codes.map((item) => ({
			code: item.code,
			note: item.note ?? args.note ?? '',
		}))
	}
	return [
		{
			code: args.code,
			note: args.note ?? '',
		},
	]
}

function assertNoDuplicateCodes(items: Array<{ code?: string; note: string }>) {
	const seen = new Set<string>()
	for (const item of items) {
		const normalized = normalizeInviteCode(item.code)
		if (!normalized) continue
		if (seen.has(normalized)) {
			throw new McpCallerError(
				`Duplicate invite code in request: ${normalized}`,
			)
		}
		seen.add(normalized)
	}
}

export const adminInviteCreateCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminInviteCreate',
		description:
			'Create one or many signup invite codes. Admin-only; returns invite metadata only (no secrets). Use codes for a launch batch with a shared maxUses.',
		keywords: [
			'admin',
			'invite',
			'invites',
			'create',
			'code',
			'signup',
			'friend',
			'bulk',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminInviteCreate',
				async () => {
					const expiresAt = parseExpiresAt(args.expiresAt)
					const items = resolveCreateItems(args)
					assertNoDuplicateCodes(items)
					const createdBy = await resolveActingAdminUserId(ctx)
					const invites: Array<AdminInviteCreated> = []
					const failed: Array<{ code: string; error: string }> = []

					for (const item of items) {
						const normalizedCode = normalizeInviteCode(item.code)
						const requestedCode = normalizedCode ?? item.code
						try {
							if (item.code !== undefined && normalizedCode === null) {
								throw new McpCallerError('Invite code must not be empty.')
							}
							const invite = await createInvite({
								db: ctx.env.APP_DB,
								code: item.code,
								createdBy,
								note: item.note,
								maxUses: args.maxUses,
								expiresAt,
								plan: args.plan,
							})
							invites.push(toCreatedInviteMetadata(invite))
						} catch (error) {
							failed.push({
								code: requestedCode ?? '',
								error:
									error instanceof Error
										? error.message
										: 'Unable to create invite.',
							})
							if (items.length === 1) {
								throw toInviteCreateError(error, requestedCode)
							}
						}
					}

					const [invite] = invites
					if (!invite) {
						throw new McpCallerError(
							failed[0]?.error ?? 'Unable to create invite.',
						)
					}

					return {
						invite,
						invites,
						failed,
					}
				},
				{
					successReason: ({ invite, invites, failed }) =>
						invites.length === 1 && failed.length === 0
							? `invite_code=${invite.code};max_uses=${invite.maxUses};plan=${invite.plan}`
							: `count=${invites.length};max_uses=${invite.maxUses};plan=${invite.plan};failed=${failed.length}`,
				},
			)
		},
	},
)
