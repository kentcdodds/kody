import { expect, test } from 'vitest'
import {
	buildHealthReport,
	encodeDeployInfo,
	parseDeployInfo,
	prefersHtml,
	pullRequestNumberFromCommitMessage,
	truncateCommitMessage,
	type DeployInfo,
} from './deploy-info.ts'

const sampleDeployInfo = {
	repoUrl: 'https://github.com/kentcdodds/kody',
	commit: {
		sha: 'f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e',
		message: 'feat: richer /health metadata (#1799)',
		committedAt: '2026-08-27T18:00:00Z',
	},
	pullRequest: {
		number: 1799,
		url: 'https://github.com/kentcdodds/kody/pull/1799',
		title: 'Richer /health metadata',
	},
	deploy: {
		deployedAt: '2026-08-27T18:05:00Z',
		environment: 'production',
		workflow: '🚀 Deploy (production)',
		job: 'deploy',
		runId: '12345',
		runUrl: 'https://github.com/kentcdodds/kody/actions/runs/12345',
	},
} satisfies DeployInfo

test('deploy info encodes for wrangler vars and rebuilds the /health report', () => {
	expect(parseDeployInfo(undefined)).toBeNull()
	expect(parseDeployInfo('not-valid')).toBeNull()
	expect(parseDeployInfo('{')).toBeNull()
	expect(parseDeployInfo(JSON.stringify(sampleDeployInfo))).toEqual(
		sampleDeployInfo,
	)
	expect(parseDeployInfo(encodeDeployInfo(sampleDeployInfo))).toEqual(
		sampleDeployInfo,
	)

	expect(buildHealthReport({})).toEqual({
		ok: true,
		commitSha: null,
		commit: null,
		pullRequest: null,
		deploy: null,
	})

	expect(
		buildHealthReport({
			APP_COMMIT_SHA: 'f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e',
		}),
	).toEqual({
		ok: true,
		commitSha: 'f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e',
		commit: {
			sha: 'f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e',
			url: 'https://github.com/kentcdodds/kody/commit/f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e',
			message: null,
			committedAt: null,
		},
		pullRequest: null,
		deploy: null,
	})

	expect(
		buildHealthReport({
			APP_COMMIT_SHA: 'f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e',
			APP_DEPLOY_INFO: encodeDeployInfo(sampleDeployInfo),
		}),
	).toEqual({
		ok: true,
		commitSha: 'f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e',
		commit: {
			sha: 'f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e',
			url: 'https://github.com/kentcdodds/kody/commit/f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e',
			message: 'feat: richer /health metadata (#1799)',
			committedAt: '2026-08-27T18:00:00Z',
		},
		pullRequest: sampleDeployInfo.pullRequest,
		deploy: sampleDeployInfo.deploy,
	})

	expect(
		buildHealthReport({
			APP_COMMIT_SHA: 'f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e',
			APP_DEPLOY_INFO: '%%%',
		}).commitSha,
	).toBe('f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e')

	expect(pullRequestNumberFromCommitMessage('feat: foo (#12)\n\n(#99)')).toBe(
		99,
	)
	expect(pullRequestNumberFromCommitMessage('no pr here')).toBeNull()
	expect(truncateCommitMessage(`${'a'.repeat(500)}extra`).length).toBe(500)
	expect(prefersHtml(null)).toBe(false)
	expect(prefersHtml('application/json')).toBe(false)
	expect(prefersHtml('text/html,application/xhtml+xml')).toBe(true)
	expect(prefersHtml('application/json, text/html')).toBe(false)
})
