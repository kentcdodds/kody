import { expect, test } from 'vitest'
import getPort from 'get-port'
import { setTimeout as delay } from 'node:timers/promises'
import {
	captureOutput,
	spawnProcess,
	stopProcess,
	wranglerBin,
} from '#mcp/test-process.ts'
import { cloudflareRestCapability } from './cloudflare-rest.ts'
import { githubGraphqlCapability } from './github-graphql.ts'
import { githubRestCapability } from './github-rest.ts'

const workerConfig = 'packages/mock-servers/github/wrangler.jsonc'
const cloudflareWorkerConfig = 'packages/mock-servers/cloudflare/wrangler.jsonc'
const projectRoot = process.cwd()
const graphqlQuery = `query RepoPull($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
    }
  }
}`

async function waitForMock(origin: string) {
	const deadline = Date.now() + 25_000
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`${origin}/__mocks/meta`)
			if (r.ok) {
				await r.body?.cancel()
				return
			}
		} catch {
			/* retry */
		}
		await delay(200)
	}
	throw new Error('mock github timeout')
}

async function waitForCloudflareMock(origin: string) {
	const deadline = Date.now() + 25_000
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`${origin}/__mocks/meta`)
			if (r.ok) {
				await r.body?.cancel()
				return
			}
		} catch {
			/* retry */
		}
		await delay(200)
	}
	throw new Error('mock cloudflare timeout')
}

async function startGithubMock(token: string) {
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
	await waitForMock(origin)
	return {
		origin,
		token,
		async [Symbol.asyncDispose]() {
			await stopProcess(proc)
		},
	}
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
			cloudflareWorkerConfig,
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
	await waitForCloudflareMock(origin)
	return {
		origin,
		token,
		async [Symbol.asyncDispose]() {
			await stopProcess(proc)
		},
	}
}

function mockContext(origin: string, token: string) {
	const env = {
		GITHUB_TOKEN: token,
		GITHUB_API_BASE_URL: origin,
	} as Env
	return {
		env,
		callerContext: {
			baseUrl: 'http://localhost:3742',
			user: null,
		},
	}
}

function mockCloudflareContext(origin: string, token: string) {
	const env = {
		CLOUDFLARE_API_TOKEN: token,
		CLOUDFLARE_API_BASE_URL: origin,
	} as Env
	return {
		env,
		callerContext: {
			baseUrl: 'http://localhost:3742',
			user: null,
		},
	}
}

test('github_rest returns JSON from mock GitHub', async () => {
	const token = 'coding-raw-token'
	await using mock = await startGithubMock(token)
	const ctx = mockContext(mock.origin, mock.token)
	const result = await githubRestCapability.handler(
		{
			method: 'GET',
			path: '/repos/kentcdodds/kody/pulls/42',
		},
		ctx,
	)
	expect(result.status).toBe(200)
	const body = result.body as { number?: number; title?: string }
	expect(body.number).toBe(42)
	expect(typeof body.title).toBe('string')
})

test('github_graphql returns data from mock GitHub', async () => {
	const token = 'coding-graphql-token'
	await using mock = await startGithubMock(token)
	const ctx = mockContext(mock.origin, mock.token)
	const result = await githubGraphqlCapability.handler(
		{
			query: graphqlQuery,
			variables: { owner: 'kentcdodds', name: 'kody', number: 42 },
		},
		ctx,
	)
	expect(result.status).toBe(200)
	const data = result.data as {
		repository?: { pullRequest?: { number?: number } }
	}
	expect(data.repository?.pullRequest?.number).toBe(42)
})

test('github_graphql rejects empty query', async () => {
	const token = 'coding-graphql-reject-token'
	await using mock = await startGithubMock(token)
	const ctx = mockContext(mock.origin, mock.token)
	await expect(
		githubGraphqlCapability.handler(
			{
				query: '',
			},
			ctx,
		),
	).rejects.toThrow('expected string to have >=1 characters')
})

test('github_rest rejects absolute URLs in path', async () => {
	const token = 'coding-raw-reject-token'
	await using mock = await startGithubMock(token)
	const ctx = mockContext(mock.origin, mock.token)
	await expect(
		githubRestCapability.handler(
			{
				method: 'GET',
				path: 'https://evil.example/api',
			},
			ctx,
		),
	).rejects.toThrow('path must start with `/`')
})

test('cloudflare_rest returns JSON from mock Cloudflare API', async () => {
	const token = 'coding-cloudflare-token'
	await using mock = await startCloudflareMock(token)
	const ctx = mockCloudflareContext(mock.origin, mock.token)
	const result = await cloudflareRestCapability.handler(
		{
			method: 'GET',
			path: '/client/v4/accounts',
		},
		ctx,
	)
	expect(result.status).toBe(200)
	const body = result.body as {
		success?: boolean
		result?: Array<{ id?: string }>
	}
	expect(body.success).toBe(true)
	expect(
		body.result?.some((account) => account.id === 'cf_account_mock_123'),
	).toBe(true)
})

test('cloudflare_rest rejects paths not under /client/v4/', async () => {
	const token = 'coding-cloudflare-reject-token'
	await using mock = await startCloudflareMock(token)
	const ctx = mockCloudflareContext(mock.origin, mock.token)
	await expect(
		cloudflareRestCapability.handler(
			{
				method: 'GET',
				path: '/zones',
			},
			ctx,
		),
	).rejects.toThrow('path must start with `/client/v4/`')
})
