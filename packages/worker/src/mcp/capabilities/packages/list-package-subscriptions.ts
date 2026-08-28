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
			'List package.json#kody.subscriptions entries for the signed-in user, optionally filtered by exact event topic. Use this to discover package event handlers such as email receipt, delivery-update, repo.pushed / repo.created / repo.deleted Artifacts lifecycle notifiers, run.error.recorded activity notifiers, integration.auth.failed / integration.auth.succeeded reconnect notifiers, mcp.server.disconnected / mcp.server.reconnected connection episodes, admin platform-feedback, admin community-activity, admin community-listing-published, admin status-incident, admin fleet.package_error_rate.elevated, admin fleet.entitlement.crossed, admin auth.denial.burst, admin email.delivery.burst, admin user.created / user.deleted, admin user.email_verification.failed, or admin user.email_outbound.paused notification subscribers before debugging dispatch or building fan-out. Admin-only topics carry only their documented narrow metadata, and declaring one does not grant delivery; dispatch checks the package owner role fresh at delivery time.',
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
			'community.listing.published',
			'community listing published',
			'status.incident.opened',
			'status incident opened',
			'status.incident.resolved',
			'status incident resolved',
			'fleet.package_error_rate.elevated',
			'fleet package error rate',
			'fleet.entitlement.crossed',
			'fleet entitlement crossed',
			'entitlement crossing',
			'user.created',
			'user created',
			'user.deleted',
			'user deleted',
			'user.email_verification.failed',
			'email verification failed',
			'user.email_outbound.paused',
			'outbound email paused',
			'auth.denial.burst',
			'auth denial burst',
			'email.delivery.burst',
			'email delivery burst',
			'account created',
			'account deleted',
			'integration.auth.failed',
			'integration.auth.succeeded',
			'mcp.server.disconnected',
			'mcp.server.reconnected',
			'mcp server disconnected',
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
					'Optional exact event topic filter such as "email.message.received", "repo.pushed", "run.error.recorded", "integration.auth.failed", "integration.auth.succeeded", "mcp.server.disconnected", "platform.feedback.submitted", "community.activity.recorded", "community.listing.published", "status.incident.opened", "fleet.package_error_rate.elevated", "fleet.entitlement.crossed", "auth.denial.burst", "email.delivery.burst", "user.created", "user.deleted", "user.email_verification.failed", or "user.email_outbound.paused".',
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
