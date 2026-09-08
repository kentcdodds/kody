import { expect, test } from 'vitest'
import { startCloudflareMock } from '#worker/test-support/cloudflare-mock-server.ts'
import { writeArtifactSourceSnapshot } from './artifact-source-snapshot.ts'
import { getArtifactsBinding } from './artifacts.ts'

const mockAccountId = 'cf_account_mock_123'

test('Cloudflare mock implements the Artifacts REST workflow used in local dev', async () => {
	const token = `cloudflare-artifacts-mock-token-${crypto.randomUUID()}`
	const repoName = `repo-${crypto.randomUUID()}`
	await using mock = await startCloudflareMock(token)
	const env = {
		CLOUDFLARE_ACCOUNT_ID: mockAccountId,
		CLOUDFLARE_API_TOKEN: mock.token,
		CLOUDFLARE_API_BASE_URL: mock.origin,
	} as Env

	const binding = getArtifactsBinding(env)
	await expect(binding.get(repoName)).resolves.toEqual({ status: 'not_found' })

	const created = await binding.create(repoName, {
		description: 'Repo 1',
		readOnly: false,
	})
	expect(created).toMatchObject({
		name: repoName,
		description: 'Repo 1',
		defaultBranch: 'main',
		remote: `${mock.origin}/git/default/${repoName}.git`,
	})
	expect(created.token).toMatch(/\?expires=\d+$/)

	const getResult = await binding.get(repoName)
	expect(getResult.status).toBe('ready')
	if (getResult.status !== 'ready') {
		throw new Error(`Expected ${repoName} to exist in mock artifacts state.`)
	}

	await expect(getResult.repo.info()).resolves.toMatchObject({
		name: repoName,
		description: 'Repo 1',
		defaultBranch: 'main',
		source: null,
		readOnly: false,
	})
	await expect(getResult.repo.createToken('read', 120)).resolves.toMatchObject({
		scope: 'read',
	})

	const listed = await binding.list()
	expect(listed.total).toBe(1)
	expect(listed.repos).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: repoName,
				readOnly: false,
			}),
		]),
	)

	const metaResponse = await fetch(`${mock.origin}/__mocks/meta?token=${token}`)
	expect(metaResponse.status).toBe(200)
	const meta = (await metaResponse.json()) as {
		artifactRepoCount?: number
	}
	expect(meta.artifactRepoCount).toBe(1)

	const sourceFiles = {
		'package.json': '{"name":"@owner/demo"}',
		'poster.png': 'not-sent-over-rpc-in-production',
	}
	await writeArtifactSourceSnapshot({
		env: {
			...env,
			CLOUDFLARE_API_SOURCE_SNAPSHOTS: 'true',
		},
		repoId: repoName,
		files: sourceFiles,
	})
	const forkedName = `${repoName}-fork`
	const forked = await binding.fork(repoName, forkedName, { readOnly: false })
	expect(forked.name).toBe(forkedName)
	const destSnapshot = await fetch(
		`${mock.origin}/client/v4/accounts/${mockAccountId}/artifacts/namespaces/default/repos/${forkedName}/mock-source-snapshot`,
		{ headers: { Authorization: `Bearer ${mock.token}` } },
	)
	expect(destSnapshot.status).toBe(200)
	const destPayload = (await destSnapshot.json()) as {
		result?: { files?: Record<string, string> }
	}
	expect(destPayload.result?.files).toEqual(sourceFiles)
}, 75_000)
