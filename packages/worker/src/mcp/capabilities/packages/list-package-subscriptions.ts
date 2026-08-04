import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'

const packageSubscriptionSchema = z.object({
	package_id: z.string(),
	kody_id: z.string(),
	name: z.string(),
	topic: z.string(),
	handler: z.string(),
	description: z.string().nullable(),
	filters: z.record(z.string(), z.unknown()).nullable(),
})

export const listPackageSubscriptionsCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_subscriptions_list',
		description:
			'List package.json#kody.subscriptions entries for the signed-in user, optionally filtered by exact event topic. Use this to discover package event handlers such as email receipt, delivery-update, repo.pushed / repo.created / repo.deleted Artifacts lifecycle notifiers, run.error.recorded activity notifiers, admin platform-feedback, or admin community-activity notification subscribers before debugging dispatch or building fan-out. Admin-only topics carry only their documented narrow metadata, and declaring one does not grant delivery; dispatch checks the package owner role fresh at delivery time.',
		keywords: [
			'package',
			'package.json#kody.subscriptions',
			'subscription',
			'subscriptions',
			'event',
			'event topic',
			'handler',
			'email.message.received',
			'email message received',
			'email.message.delivery.updated',
			'email delivery updated',
			'email.system-message.received',
			'system email',
			'run.error.recorded',
			'run error recorded',
			'activity error',
			'repo.pushed',
			'repo pushed',
			'repo.created',
			'repo.deleted',
			'artifacts push',
			'platform.feedback.submitted',
			'platform feedback submitted',
			'community.activity.recorded',
			'community activity recorded',
			'inbound email',
			'list',
			'discover',
			'manifest',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			topic: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Optional exact event topic filter such as "email.message.received", "repo.pushed", "run.error.recorded", "platform.feedback.submitted", or "community.activity.recorded".',
				),
		}),
		outputSchema: z.object({
			subscriptions: z.array(packageSubscriptionSchema),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const packages = await listSavedPackagesByUserId(ctx.env.APP_DB, {
				userId: user.userId,
			})
			const loadedManifests = await Promise.all(
				packages.map(async (savedPackage) => ({
					savedPackage,
					loaded: await loadPackageManifestBySourceId({
						env: ctx.env,
						baseUrl: ctx.callerContext.baseUrl,
						userId: user.userId,
						sourceId: savedPackage.sourceId,
					}).catch((error) => {
						console.warn('Failed to load package manifest for subscriptions', {
							packageId: savedPackage.id,
							sourceId: savedPackage.sourceId,
							error,
						})
						return null
					}),
				})),
			)
			const subscriptions: Array<z.infer<typeof packageSubscriptionSchema>> = []
			for (const { savedPackage, loaded } of loadedManifests) {
				if (!loaded) continue
				const declared = loaded.manifest.kody.subscriptions ?? {}
				for (const [topic, definition] of Object.entries(declared)) {
					if (args.topic && args.topic !== topic) continue
					subscriptions.push({
						package_id: savedPackage.id,
						kody_id: savedPackage.kodyId,
						name: savedPackage.name,
						topic,
						handler: definition.handler,
						description: definition.description ?? null,
						filters: definition.filters ?? null,
					})
				}
			}
			return {
				subscriptions: subscriptions.sort((left, right) => {
					return (
						left.topic.localeCompare(right.topic) ||
						left.kody_id.localeCompare(right.kody_id)
					)
				}),
			}
		},
	},
)
