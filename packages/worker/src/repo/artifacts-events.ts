import { z } from 'zod'

export const repoPushedTopic = 'repo.pushed'
export const repoCreatedTopic = 'repo.created'
export const repoDeletedTopic = 'repo.deleted'

export const repoSubscriptionTopics = [
	repoPushedTopic,
	repoCreatedTopic,
	repoDeletedTopic,
] as const

export type RepoSubscriptionTopic = (typeof repoSubscriptionTopics)[number]

const artifactsPersonSchema = z.object({
	name: z.string(),
	email: z.string(),
})

const artifactsCommitSchema = z.object({
	id: z.string().min(1),
	message: z.string(),
	messageTruncated: z.boolean(),
	timestamp: z.string().min(1),
	author: artifactsPersonSchema,
	committer: artifactsPersonSchema,
	parents: z.array(z.string()),
})

const artifactsEventMetadataSchema = z.object({
	accountId: z.string().min(1),
	eventSubscriptionId: z.string().min(1),
	eventSchemaVersion: z.number().int().positive(),
	eventTimestamp: z.iso.datetime(),
})

const artifactsAccountSourceSchema = z.object({
	type: z.literal('artifacts'),
	namespace: z.string().min(1),
	repoName: z.string().min(1),
})

const artifactsRepoSourceSchema = z.object({
	type: z.literal('artifacts.repo'),
	namespace: z.string().min(1),
	repoName: z.string().min(1),
})

const artifactsRepoLifecyclePayloadSchema = z.object({
	repoId: z.string().min(1),
	defaultBranch: z.string().min(1),
	description: z.string().nullable().optional(),
	readOnly: z.boolean().optional(),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
	lastPushAt: z.string().nullable().optional(),
})

const cloudflareArtifactsRepoCreatedEventSchema = z.object({
	type: z.literal('cf.artifacts.repo.created'),
	source: artifactsAccountSourceSchema,
	payload: artifactsRepoLifecyclePayloadSchema,
	metadata: artifactsEventMetadataSchema,
})

const cloudflareArtifactsRepoDeletedEventSchema = z.object({
	type: z.literal('cf.artifacts.repo.deleted'),
	source: artifactsAccountSourceSchema,
	payload: artifactsRepoLifecyclePayloadSchema,
	metadata: artifactsEventMetadataSchema,
})

const cloudflareArtifactsRepoPushedEventSchema = z.object({
	type: z.literal('cf.artifacts.repo.pushed'),
	source: artifactsRepoSourceSchema,
	payload: z.object({
		ref: z.string().min(1),
		before: z.string().min(1),
		after: z.string().min(1),
		commits: z.array(artifactsCommitSchema),
		totalCommitsCount: z.number().int().nonnegative(),
		commitsTruncated: z.boolean(),
	}),
	metadata: artifactsEventMetadataSchema,
})

export const cloudflareArtifactsRepoEventSchema = z.discriminatedUnion('type', [
	cloudflareArtifactsRepoCreatedEventSchema,
	cloudflareArtifactsRepoDeletedEventSchema,
	cloudflareArtifactsRepoPushedEventSchema,
])

export type CloudflareArtifactsRepoEvent = z.infer<
	typeof cloudflareArtifactsRepoEventSchema
>

export function parseCloudflareArtifactsRepoEvent(input: unknown) {
	const result = cloudflareArtifactsRepoEventSchema.safeParse(input)
	return result.success ? result.data : null
}

export function topicForArtifactsRepoEvent(
	event: CloudflareArtifactsRepoEvent,
): RepoSubscriptionTopic {
	switch (event.type) {
		case 'cf.artifacts.repo.pushed':
			return repoPushedTopic
		case 'cf.artifacts.repo.created':
			return repoCreatedTopic
		case 'cf.artifacts.repo.deleted':
			return repoDeletedTopic
		default: {
			const exhaustive: never = event
			throw new Error(
				`Unsupported Artifacts repo event type: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

/**
 * Session fork Artifacts names look like `package-<id>-session-<sessionId>`.
 * They are ephemeral and must not get durable push subscriptions or package
 * subscription fan-out.
 */
export function isSessionArtifactRepoName(repoName: string) {
	return /-session-/.test(repoName)
}
