import { expect, test } from 'vitest'
import {
	encodeDeployInfo,
	parseDeployInfo,
	type DeployInfo,
} from '#worker/deploy-info.ts'
import {
	buildDeployInfo,
	readDeployInfoInputFromEnv,
} from './build-deploy-info.ts'

const commitSha = 'f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e'

test('build-deploy-info collects git, PR, and Actions metadata for /health', async () => {
	const fromEnv = readDeployInfoInputFromEnv({
		DEPLOY_COMMIT_SHA: commitSha,
		DEPLOY_ENVIRONMENT: 'preview',
		GITHUB_SERVER_URL: 'https://github.com',
		GITHUB_REPOSITORY: 'kentcdodds/kody',
		GITHUB_WORKFLOW: '🔎 Preview',
		GITHUB_JOB: 'deploy',
		GITHUB_RUN_ID: '99',
		GITHUB_RUN_ATTEMPT: '2',
		DEPLOY_PR_NUMBER: '1799',
		DEPLOY_PR_URL: 'https://github.com/kentcdodds/kody/pull/1799',
		DEPLOY_PR_TITLE: 'Richer /health metadata',
		DEPLOYED_AT: '2026-08-27T18:05:00Z',
	})
	expect(fromEnv.sha).toBe(commitSha)
	expect(fromEnv.repoUrl).toBe('https://github.com/kentcdodds/kody')
	expect(fromEnv.pullRequest).toEqual({
		number: 1799,
		url: 'https://github.com/kentcdodds/kody/pull/1799',
		title: 'Richer /health metadata',
	})

	const info = await buildDeployInfo({
		...fromEnv,
		commit: {
			message: 'feat: richer /health metadata (#1799)\n\nMore detail.',
			committedAt: '2026-08-27T18:00:00Z',
		},
	})
	expect(info).toEqual({
		repoUrl: 'https://github.com/kentcdodds/kody',
		commit: {
			sha: commitSha,
			message: 'feat: richer /health metadata (#1799)\n\nMore detail.',
			committedAt: '2026-08-27T18:00:00Z',
		},
		pullRequest: fromEnv.pullRequest,
		deploy: {
			deployedAt: '2026-08-27T18:05:00Z',
			environment: 'preview',
			workflow: '🔎 Preview',
			job: 'deploy',
			runId: '99',
			runUrl: 'https://github.com/kentcdodds/kody/actions/runs/99/attempts/2',
		},
	} satisfies DeployInfo)
	expect(parseDeployInfo(encodeDeployInfo(info))).toEqual(info)

	expect(
		(
			await buildDeployInfo({
				sha: commitSha,
				commit: {
					message: 'squash merge without lookup (#42)',
					committedAt: null,
				},
				pullRequest: null,
				lookupPullRequests: async () => [],
				now: '2026-08-27T18:05:00Z',
			})
		).pullRequest,
	).toBeNull()

	expect(
		(
			await buildDeployInfo({
				sha: commitSha,
				commit: {
					message: 'squash merge without lookup (#42)',
					committedAt: null,
				},
				lookupPullRequests: async () => [],
				now: '2026-08-27T18:05:00Z',
			})
		).pullRequest,
	).toEqual({
		number: 42,
		url: 'https://github.com/kentcdodds/kody/pull/42',
		title: null,
	})

	expect(
		(
			await buildDeployInfo({
				sha: commitSha,
				commit: { message: 'no pr in message', committedAt: null },
				lookupPullRequests: async () => [
					{
						number: 7,
						url: 'https://github.com/kentcdodds/kody/pull/7',
						title: 'From API',
					},
				],
				now: '2026-08-27T18:05:00Z',
			})
		).pullRequest?.number,
	).toBe(7)

	expect(() => readDeployInfoInputFromEnv({})).toThrow(/DEPLOY_COMMIT_SHA/)
})
