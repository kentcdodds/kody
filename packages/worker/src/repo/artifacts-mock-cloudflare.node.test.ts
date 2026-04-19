import { expect, test } from 'vitest'
import getPort from 'get-port'
import { setTimeout as delay } from 'node:timers/promises'
import {
	captureOutput,
	spawnProcess,
	stopProcess,
	wranglerBin,
} from '#mcp/test-process.ts'
import { getArtifactsBinding } from './artifacts.ts'

const workerConfig = 'packages/mock-servers/cloudflare/wrangler.jsonc'
const projectRoot = process.cwd()
const mockAccountId = 'cf_account_mock_123'

async function waitForMock(origin: string) {
	const deadline = Date.now() + 25_000
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${origin}/__mocks/meta`)
			if (response.ok) {
				await response.body?.cancel()
				return
			}
		} catch {
			/* retry */
		}
		await delay(200)
	}
	throw new Error('mock cloudflare timeout')
}

async function startCloudflareMock(token: string) {
	const port = await getPort({ host: '127.0.0.1' })
	const origin = `http://127.0.0.1:${port}`
	const inspectorPort = await getPort({ host: '127.0.0.1' })
	const proc = spawnProcess({
		cmd: [
			wranglerBin,
			'dev',
			'--local',
			'--config',
			workerConfig,
			'--var',
			`MOCK_API_TOKEN:${token}`,
			'--port',
			String(port),
			'--inspector-port',
			String(inspectorPort),
			'--ip',
			'127.0.0.1',
			'--show-interactive-dev-session=false',
			'--log-level',
			'error',
		],
		cwd: projectRoot,
	})
	captureOutput(proc.stdout)
	captureOutput(proc.stderr)
	const mock = {
		origin,
		token,
		async [Symbol.asyncDispose]() {
			await stopProcess(proc)
		},
	}
	try {
		await waitForMock(origin)
		return mock
	} catch (error) {
		await stopProcess(proc)
		throw error
	}
}

test('Cloudflare mock implements the Artifacts REST workflow used in local dev', async () => {
	const token = `cloudflare-artifacts-mock-token-${crypto.randomUUID()}`
	const repoName = `repo-${crypto.randomUUID()}`
	const forkName = `repo-copy-${crypto.randomUUID()}`
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

	const forked = await getResult.repo.fork({
		name: forkName,
		readOnly: true,
	})
	expect(forked).toMatchObject({
		name: forkName,
		defaultBranch: 'main',
		remote: `${mock.origin}/git/default/${forkName}.git`,
	})
	expect(forked.token).toMatch(/\?expires=\d+$/)

	const listed = await binding.list()
	expect(listed.total).toBe(2)
	expect(listed.repos).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: repoName,
				readOnly: false,
			}),
			expect.objectContaining({
				name: forkName,
				readOnly: true,
				source: repoName,
			}),
		]),
	)

	const metaResponse = await fetch(`${mock.origin}/__mocks/meta?token=${token}`)
	expect(metaResponse.status).toBe(200)
	const meta = (await metaResponse.json()) as {
		artifactRepoCount?: number
	}
	expect(meta.artifactRepoCount).toBe(2)
})
