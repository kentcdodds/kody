import { expect, test } from 'vitest'
import getPort from 'get-port'
import { setTimeout as delay } from 'node:timers/promises'
import {
	captureOutput,
	spawnProcess,
	stopProcess,
	wranglerBin,
} from '#mcp/test-process.ts'
import {
	createGitHubGraphqlClient,
	GitHubGraphqlClient,
} from './github-graphql-client.ts'

const workerConfig = 'packages/mock-servers/github/wrangler.jsonc'
const projectRoot = process.cwd()

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
	void captureOutput(proc.stdout)
	void captureOutput(proc.stderr)
	await waitForMock(origin)
	return {
		origin,
		token,
		async [Symbol.asyncDispose]() {
			await stopProcess(proc)
		},
	}
}

const graphqlQuery = `query RepoPull($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
    }
  }
}`

test('GitHubGraphqlClient query reads pull request data from the mock', async () => {
	const token = 'graphql-client-token'
	await using mock = await startGithubMock(token)
	const client = new GitHubGraphqlClient({
		token: mock.token,
		baseUrl: mock.origin,
	})
	const response = await client.query({
		query: graphqlQuery,
		variables: { owner: 'kentcdodds', name: 'kody', number: 42 },
	})
	expect(response.status).toBe(200)
	const body = response.body as {
		data?: { repository?: { pullRequest?: { number?: number } } }
	}
	expect(body.data?.repository?.pullRequest?.number).toBe(42)
})

test('createGitHubGraphqlClient uses GITHUB_API_BASE_URL for query', async () => {
	const token = 'graphql-client-token-2'
	await using mock = await startGithubMock(token)
	const client = createGitHubGraphqlClient({
		GITHUB_TOKEN: mock.token,
		GITHUB_API_BASE_URL: mock.origin,
	} as Pick<Env, 'GITHUB_TOKEN' | 'GITHUB_API_BASE_URL'>)
	const response = await client.query({
		query: graphqlQuery,
		variables: { owner: 'kentcdodds', name: 'kody', number: 42 },
	})
	expect(response.status).toBe(200)
})
