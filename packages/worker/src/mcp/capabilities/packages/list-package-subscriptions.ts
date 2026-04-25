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
		name: 'package_subscription_list',
		description:
			'List manifest-declared package subscriptions for the signed-in user, optionally filtered by topic.',
		keywords: [
			'package',
			'subscription',
			'event',
			'handler',
			'list',
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
				.describe('Optional exact topic filter.'),
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
					}).catch(() => null),
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
