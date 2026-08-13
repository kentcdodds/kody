import { expect, test } from 'vitest'
import {
	isSessionArtifactRepoName,
	parseCloudflareArtifactsRepoEvent,
	repoCreatedTopic,
	repoDeletedTopic,
	repoPushedTopic,
	topicForArtifactsRepoEvent,
} from './artifacts-events.ts'

const metadata = {
	accountId: 'account-1',
	eventSubscriptionId: 'subscription-1',
	eventSchemaVersion: 1,
	eventTimestamp: '2026-05-18T15:53:48.187Z',
}

test('artifacts event helpers parse envelopes, reject unknowns, and detect session forks', () => {
	const pushed = parseCloudflareArtifactsRepoEvent({
		type: 'cf.artifacts.repo.pushed',
		source: {
			type: 'artifacts.repo',
			namespace: 'production',
			repoName: 'repo-abc',
		},
		payload: {
			ref: 'refs/heads/main',
			before: 'abc123def456abc123def456abc123def456abc1',
			after: 'def789ghi012def789ghi012def789ghi012def7',
			commits: [
				{
					id: 'def789ghi012def789ghi012def789ghi012def7',
					message: 'Update skills index',
					messageTruncated: false,
					timestamp: '2026-05-01T02:48:57.000Z',
					author: { name: 'Dev', email: 'dev@example.com' },
					committer: { name: 'Dev', email: 'dev@example.com' },
					parents: ['abc123def456abc123def456abc123def456abc1'],
				},
			],
			totalCommitsCount: 1,
			commitsTruncated: false,
		},
		metadata,
	})
	expect(pushed?.type).toBe('cf.artifacts.repo.pushed')
	expect(pushed?.source.type).toBe('artifacts.repo')
	expect(topicForArtifactsRepoEvent(pushed!)).toBe(repoPushedTopic)

	const accountPushed = parseCloudflareArtifactsRepoEvent({
		type: 'cf.artifacts.repo.pushed',
		source: {
			type: 'artifacts',
			namespace: 'production',
			repoName: 'repo-abc',
		},
		payload: {
			ref: 'refs/heads/main',
			before: 'abc123def456abc123def456abc123def456abc1',
			after: 'def789ghi012def789ghi012def789ghi012def7',
			commits: [],
			totalCommitsCount: 0,
			commitsTruncated: false,
		},
		metadata,
	})
	expect(accountPushed?.source.type).toBe('artifacts')
	expect(topicForArtifactsRepoEvent(accountPushed!)).toBe(repoPushedTopic)

	const created = parseCloudflareArtifactsRepoEvent({
		type: 'cf.artifacts.repo.created',
		source: {
			type: 'artifacts',
			namespace: 'production',
			repoName: 'package-xyz',
		},
		payload: {
			repoId: '0tvugavnogssnwzk',
			defaultBranch: 'main',
			description: null,
			readOnly: false,
			createdAt: '2026-05-18T15:53:46.833Z',
			updatedAt: '2026-05-18T15:53:46.833Z',
			lastPushAt: null,
		},
		metadata,
	})
	expect(topicForArtifactsRepoEvent(created!)).toBe(repoCreatedTopic)

	const deleted = parseCloudflareArtifactsRepoEvent({
		type: 'cf.artifacts.repo.deleted',
		source: {
			type: 'artifacts',
			namespace: 'production',
			repoName: 'package-xyz',
		},
		payload: {
			repoId: '0tvugavnogssnwzk',
			defaultBranch: 'main',
		},
		metadata,
	})
	expect(topicForArtifactsRepoEvent(deleted!)).toBe(repoDeletedTopic)

	expect(parseCloudflareArtifactsRepoEvent(null)).toBeNull()
	expect(
		parseCloudflareArtifactsRepoEvent({
			type: 'cf.artifacts.repo.cloned',
			source: {
				type: 'artifacts.repo',
				namespace: 'production',
				repoName: 'repo-abc',
			},
			payload: {},
			metadata,
		}),
	).toBeNull()

	expect(
		isSessionArtifactRepoName(
			'package-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-session-11111111-2222-3333-4444-555555555555',
		),
	).toBe(true)
	expect(
		isSessionArtifactRepoName('repo-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
	).toBe(false)
})
