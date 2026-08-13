import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http'
import { expect, test } from 'vitest'
import {
	cookieHeaderFromSetCookie,
	deriveSiblingWorkerUrl,
	displayTitleMentionsPr,
	evaluateAppHealth,
	evaluateRuntimeHealth,
	flattenGhJsonPages,
	formatBriefing,
	parseArgs,
	parsePreviewComment,
	parseSessionRequest,
	previewCommentMarker,
	previewSeedEmail,
	previewSeedPassword,
	runPreviewManualTest,
	workerNameFromPreviewUrl,
	type GhResult,
	type PreviewManualTestDeps,
	type PreviewManualTestResult,
} from './preview-manual-test.ts'

const sampleComment = [
	previewCommentMarker,
	'🔎 Preview deployed: https://kody-pr-42.kody.workers.dev',
	'',
	'Worker: `kody-pr-42`',
	'Runtime worker: `kody-pr-42-runtime` (https://kody-pr-42-runtime.kody.workers.dev)',
	'D1: `kody-pr-42-db`',
	'KV: `kody-pr-42-oauth-kv`',
	'',
	'Mocks:',
	'- cloudflare: [https://kody-pr-42-mock-cloudflare.kody.workers.dev/__mocks](https://kody-pr-42-mock-cloudflare.kody.workers.dev/__mocks?token=abc) (`kody-pr-42-mock-cloudflare`)',
].join('\n')

test('preview manual test parses flags, PR comments, worker URLs, and health payloads', () => {
	const options = parseArgs([
		'--pr',
		'42',
		'--no-wait',
		'--skip-login',
		'--timeout-ms',
		'1000',
		'--poll-ms',
		'50',
		'--sha',
		'abc123',
		'--json',
	])
	expect(options.prNumber).toBe(42)
	expect(options.wait).toBe(false)
	expect(options.skipLogin).toBe(true)
	expect(options.timeoutMs).toBe(1000)
	expect(options.pollIntervalMs).toBe(50)
	expect(options.expectedSha).toBe('abc123')
	expect(options.json).toBe(true)

	expect(() => parseArgs(['--nope'])).toThrow(/Unknown flag/)
	expect(() => parseArgs(['--check', '/account', '--skip-login'])).toThrow(
		/--check requires a session cookie/,
	)
	expect(() =>
		parseArgs(['--request', 'GET /account/values.json', '--skip-login']),
	).toThrow(/--request requires a session cookie/)
	expect(
		parseArgs([
			'--request',
			'POST /account/values.json {"action":"save","name":"locale","value":"en-US"}',
			'--request',
			'GET /admin 403',
			'--cookie-file',
			'.tmp/preview-cookie',
		]),
	).toEqual(
		expect.objectContaining({
			cookieFile: '.tmp/preview-cookie',
			sessionRequests: [
				{
					method: 'POST',
					path: '/account/values.json',
					expectedStatus: null,
					body: { action: 'save', name: 'locale', value: 'en-US' },
				},
				{
					method: 'GET',
					path: '/admin',
					expectedStatus: 403,
					body: null,
				},
			],
		}),
	)
	expect(parseSessionRequest('GET /account/values.json')).toEqual({
		method: 'GET',
		path: '/account/values.json',
		expectedStatus: null,
		body: null,
	})
	expect(() => parseSessionRequest('FETCH /nope')).toThrow(/Invalid --request/)

	expect(parsePreviewComment('no marker here')).toBeNull()
	expect(parsePreviewComment(sampleComment)).toEqual({
		previewUrl: 'https://kody-pr-42.kody.workers.dev',
		workerName: 'kody-pr-42',
		runtimeWorkerName: 'kody-pr-42-runtime',
		runtimeUrl: 'https://kody-pr-42-runtime.kody.workers.dev',
		d1DatabaseName: 'kody-pr-42-db',
		oauthKvTitle: 'kody-pr-42-oauth-kv',
		mocks: [
			'cloudflare: [https://kody-pr-42-mock-cloudflare.kody.workers.dev/__mocks](https://kody-pr-42-mock-cloudflare.kody.workers.dev/__mocks?token=abc) (`kody-pr-42-mock-cloudflare`)',
		],
	})
	expect(
		parsePreviewComment(sampleCommentWithUrl('http://127.0.0.1:9')),
	).toEqual({
		previewUrl: 'http://127.0.0.1:9',
		workerName: 'kody-pr-42',
		runtimeWorkerName: null,
		runtimeUrl: null,
		d1DatabaseName: null,
		oauthKvTitle: null,
		mocks: [],
	})

	expect(workerNameFromPreviewUrl('https://kody-pr-42.kody.workers.dev')).toBe(
		'kody-pr-42',
	)
	expect(workerNameFromPreviewUrl('http://127.0.0.1:3742')).toBeNull()
	expect(
		deriveSiblingWorkerUrl(
			'https://kody-pr-42.kody.workers.dev',
			'kody-pr-42',
			'kody-pr-42-runtime',
		),
	).toBe('https://kody-pr-42-runtime.kody.workers.dev')

	expect(
		cookieHeaderFromSetCookie(['kody_session=abc; Path=/; HttpOnly']),
	).toBe('kody_session=abc')

	expect(evaluateAppHealth({ ok: true, commitSha: 'abc' }, 'abc')).toEqual({
		ok: true,
		commitSha: 'abc',
		detail: 'ok, commitSha abc',
	})
	expect(evaluateAppHealth({ ok: true, commitSha: 'old' }, 'new').ok).toBe(
		false,
	)
	expect(
		evaluateAppHealth({ ok: true, commitSha: 'mergesha' }, 'headsha', [
			'basesha',
			'headsha',
		]),
	).toEqual({
		ok: true,
		commitSha: 'mergesha',
		detail: 'ok, commitSha mergesha (merge of headsha)',
	})
	expect(
		evaluateRuntimeHealth(
			{ status: 'ok', commitSha: 'abc', cookieSecretConfigured: true },
			null,
		).ok,
	).toBe(true)
	expect(
		evaluateRuntimeHealth(
			{ status: 'ok', commitSha: 'abc', cookieSecretConfigured: false },
			null,
		).ok,
	).toBe(false)

	expect(displayTitleMentionsPr('Preview #42', 42)).toBe(true)
	expect(displayTitleMentionsPr('Preview #42', 4)).toBe(false)
	expect(displayTitleMentionsPr('Preview #4', 4)).toBe(true)
	expect(displayTitleMentionsPr('Preview #4 from main', 4)).toBe(true)
	expect(displayTitleMentionsPr(undefined, 4)).toBe(false)

	expect(flattenGhJsonPages([{ body: 'a' }, { body: 'b' }])).toEqual([
		{ body: 'a' },
		{ body: 'b' },
	])
	expect(
		flattenGhJsonPages([[{ body: 'a' }], [{ body: 'b' }, { body: 'c' }]]),
	).toEqual([{ body: 'a' }, { body: 'b' }, { body: 'c' }])
	expect(flattenGhJsonPages({ not: 'an array' })).toEqual([])

	const briefing = formatBriefing({
		ok: true,
		message: 'ready',
		options,
		snapshot: {
			prNumber: 42,
			prUrl: 'https://github.com/kentcdodds/kody/pull/42',
			isDraft: false,
			headSha: 'headsha',
			previewUrl: 'https://kody-pr-42.kody.workers.dev',
			workerName: 'kody-pr-42',
			runtimeWorkerName: 'kody-pr-42-runtime',
			runtimeUrl: 'https://kody-pr-42-runtime.kody.workers.dev',
			d1DatabaseName: 'kody-pr-42-db',
			oauthKvTitle: 'kody-pr-42-oauth-kv',
			mocks: [],
			expectedSha: 'mergesha',
			workflowUrl: 'https://github.com/kentcdodds/kody/actions/runs/1',
			workflowStatus: 'completed',
			workflowConclusion: 'success',
			workflowHeadSha: 'headsha',
			deploymentSha: 'mergesha',
		},
		smoke: {
			ok: true,
			checks: [
				{ name: 'GET /health', ok: true, detail: 'ok, commitSha mergesha' },
			],
			sessionEmail: previewSeedEmail,
			commitSha: 'mergesha',
			runtimeCommitSha: 'mergesha',
			cookieHeader: 'kody_session=abc',
		},
		session: {
			cookieHeader: 'kody_session=abc',
			origin: 'https://kody-pr-42.kody.workers.dev',
			cookieFile: null,
		},
		login: {
			email: previewSeedEmail,
			password: previewSeedPassword,
			username: 'user-me',
			admin: false,
		},
		briefing: '',
	} satisfies PreviewManualTestResult)
	expect(briefing).toContain('Preview is ready for manual testing.')
	expect(briefing).toContain(`${previewSeedEmail} / ${previewSeedPassword}`)
	expect(briefing).toContain('user-me')
	expect(briefing).toContain('merge commit')
	expect(briefing).toContain('computerUse')
	expect(briefing).toContain('--request')
	expect(briefing).toContain('session.cookieHeader')
})

test('preview manual test smokes a local preview: health, login page, auth, session, account, mcp', async () => {
	await using server = await createPreviewFixtureServer()
	const logs: Array<string> = []
	const files = new Map<string, string>()
	const { exitCode, result } = await runPreviewManualTest(
		[
			'--url',
			server.origin,
			'--no-wait',
			'--cookie-file',
			'.tmp/preview-cookie',
			'--request',
			'POST /account/values.json {"action":"save","name":"preview-locale","value":"en-US"}',
			'--request',
			'GET /account/values.json',
			'--request',
			'GET /admin 403',
			'--check',
			'/account/secrets',
		],
		createSilentDeps({ logs, files }),
	)

	expect(exitCode).toBe(0)
	expect(result?.ok).toBe(true)
	expect(result?.smoke?.ok).toBe(true)
	expect(result?.smoke?.sessionEmail).toBe(previewSeedEmail)
	expect(result?.session.cookieHeader).toBe('kody_session=test-cookie')
	expect(files.get('.tmp/preview-cookie')).toBe('kody_session=test-cookie\n')
	expect(result?.smoke?.checks.map((check) => check.name)).toEqual([
		'GET /health',
		'GET /login',
		'GET /mcp',
		'POST /auth',
		'GET /session',
		'GET /account',
		'cookie-file',
		'POST /account/values.json (2xx)',
		'GET /account/values.json (2xx)',
		'GET /admin (403)',
		'GET /account/secrets',
	])
	expect(result?.briefing).toContain(server.origin)
	expect(logs.join('\n')).toContain('Preview is ready for manual testing.')
})

test('preview manual test waits for the GitHub preview comment, then smokes the URL', async () => {
	await using server = await createPreviewFixtureServer()
	let now = 0
	let prViews = 0
	const logs: Array<string> = []
	const deps = createSilentDeps({
		logs,
		now: () => now,
		sleep: async (ms) => {
			now += ms
		},
		execGh: async (args) => {
			if (args.join(' ').startsWith('pr view')) prViews += 1
			return fakeGh(args, {
				commentBody: prViews >= 2 ? sampleCommentWithUrl(server.origin) : null,
				headSha: 'headsha',
				deploymentSha: 'deployedsha',
				runStatus: prViews >= 2 ? 'completed' : 'in_progress',
				runConclusion: prViews >= 2 ? 'success' : null,
			})
		},
	})

	const { exitCode, result } = await runPreviewManualTest(
		[
			'--pr',
			'42',
			'--timeout-ms',
			'30000',
			'--poll-ms',
			'1000',
			'--skip-login',
		],
		deps,
	)

	expect(exitCode).toBe(0)
	expect(result?.ok).toBe(true)
	expect(result?.snapshot.previewUrl).toBe(server.origin)
	expect(
		result?.smoke?.checks.some((check) => check.name === 'POST /auth'),
	).toBe(false)
	expect(logs.some((line) => line.includes('Waiting'))).toBe(true)
})

test('preview manual test waits for the head SHA workflow even when /health already matches', async () => {
	await using server = await createPreviewFixtureServer()
	let now = 0
	let prViews = 0
	const logs: Array<string> = []
	const deps = createSilentDeps({
		logs,
		now: () => now,
		sleep: async (ms) => {
			now += ms
		},
		execGh: async (args) => {
			if (args.join(' ').startsWith('pr view')) prViews += 1
			return fakeGh(args, {
				commentBody: sampleCommentWithUrl(server.origin),
				headSha: 'headsha',
				deploymentSha: 'deployedsha',
				runStatus: prViews >= 2 ? 'completed' : 'in_progress',
				runConclusion: prViews >= 2 ? 'success' : null,
			})
		},
	})

	const { exitCode, result } = await runPreviewManualTest(
		[
			'--pr',
			'42',
			'--timeout-ms',
			'30000',
			'--poll-ms',
			'1000',
			'--skip-login',
		],
		deps,
	)

	expect(exitCode).toBe(0)
	expect(prViews).toBeGreaterThanOrEqual(2)
	expect(result?.snapshot.workflowStatus).toBe('completed')
	expect(result?.snapshot.workflowConclusion).toBe('success')
	expect(
		logs.some((line) => line.includes('Waiting for preview workflow')),
	).toBe(true)
})

test('preview manual test treats merge-commit /health as ready when it contains the PR head', async () => {
	await using server = await createPreviewFixtureServer('mergesha')
	const logs: Array<string> = []
	const runListCalls: Array<ReadonlyArray<string>> = []
	const { exitCode, result } = await runPreviewManualTest(
		['--pr', '42', '--skip-login'],
		createSilentDeps({
			logs,
			execGh: async (args) => {
				if (args[0] === 'run' && args[1] === 'list') runListCalls.push(args)
				return fakeGh(args, {
					commentBody: sampleCommentWithUrl(server.origin),
					headSha: 'headsha',
					deploymentSha: 'headsha',
					runStatus: 'completed',
					runConclusion: 'success',
					commitParents: ['basesha', 'headsha'],
				})
			},
		}),
	)

	expect(exitCode).toBe(0)
	expect(result?.ok).toBe(true)
	expect(result?.smoke?.commitSha).toBe('mergesha')
	expect(
		result?.smoke?.checks.find((check) => check.name === 'GET /health')?.detail,
	).toContain('merge of headsha')
	expect(runListCalls.length).toBeGreaterThan(0)
	expect(runListCalls[0]).toEqual(
		expect.arrayContaining([
			'--commit',
			'headsha',
			'--workflow',
			'preview.yml',
		]),
	)
})

test('preview manual test records fetch failures as checks instead of aborting the briefing', async () => {
	const logs: Array<string> = []
	const { exitCode, result } = await runPreviewManualTest(
		[
			'--url',
			'https://kody-pr-42.example.invalid',
			'--no-wait',
			'--skip-login',
		],
		{
			...createSilentDeps({ logs }),
			fetch: async () => {
				throw new Error('The operation was aborted due to timeout')
			},
		},
	)

	expect(exitCode).toBe(1)
	expect(result).not.toBeNull()
	expect(result?.briefing).toContain('GET /health')
	expect(
		result?.smoke?.checks.some(
			(check) =>
				check.name === 'GET /health' &&
				!check.ok &&
				check.detail.includes('aborted due to timeout'),
		),
	).toBe(true)
	expect(
		result?.smoke?.checks.some((check) => check.name === 'GET /login'),
	).toBe(true)
})

test('preview manual test records cookie-file write failures as checks', async () => {
	await using server = await createPreviewFixtureServer()
	const logs: Array<string> = []
	const { exitCode, result } = await runPreviewManualTest(
		[
			'--url',
			server.origin,
			'--no-wait',
			'--cookie-file',
			'.tmp/preview-cookie',
		],
		{
			...createSilentDeps({ logs }),
			writeFile: async () => {
				throw new Error(
					"ENOENT: no such file or directory, open '.tmp/preview-cookie'",
				)
			},
		},
	)

	expect(exitCode).toBe(1)
	expect(result).not.toBeNull()
	expect(result?.session.cookieHeader).toBe('kody_session=test-cookie')
	expect(
		result?.smoke?.checks.find((check) => check.name === 'cookie-file'),
	).toEqual({
		name: 'cookie-file',
		ok: false,
		detail: "ENOENT: no such file or directory, open '.tmp/preview-cookie'",
	})
	expect(result?.briefing).toContain('POST /auth')
})

test('preview manual test refuses draft PRs and failed preview workflows', async () => {
	const logs: Array<string> = []
	const draft = await runPreviewManualTest(['--pr', '9', '--no-wait'], {
		...createSilentDeps({ logs }),
		execGh: async (args) =>
			fakeGh(args, {
				isDraft: true,
				commentBody: null,
			}),
	})
	expect(draft.exitCode).toBe(1)
	expect(draft.result).toBeNull()
	expect(logs.join('\n')).toMatch(/draft/i)

	logs.length = 0
	const failed = await runPreviewManualTest(
		['--pr', '9', '--timeout-ms', '1000', '--poll-ms', '10'],
		{
			...createSilentDeps({
				logs,
				now: () => 0,
				sleep: async () => {
					// The failed conclusion should abort before a sleep.
				},
			}),
			execGh: async (args) =>
				fakeGh(args, {
					commentBody: null,
					runStatus: 'completed',
					runConclusion: 'failure',
					runUrl: 'https://github.com/kentcdodds/kody/actions/runs/99',
				}),
		},
	)
	expect(failed.exitCode).toBe(1)
	expect(logs.join('\n')).toMatch(/Preview workflow failure/)
})

function sampleCommentWithUrl(previewUrl: string) {
	return [
		previewCommentMarker,
		`🔎 Preview deployed: ${previewUrl}`,
		'',
		'Worker: `kody-pr-42`',
	].join('\n')
}

function createSilentDeps(
	overrides: Partial<PreviewManualTestDeps> & {
		logs: Array<string>
		files?: Map<string, string>
	},
): PreviewManualTestDeps {
	const { logs, files = new Map<string, string>(), ...rest } = overrides
	return {
		execGh: async () => ({ status: 1, stdout: '', stderr: 'unused' }),
		fetch,
		sleep: async () => {
			// Tests that wait inject their own clock.
		},
		now: () => Date.now(),
		log: (message) => {
			logs.push(message)
		},
		error: (message) => {
			logs.push(message)
		},
		print: (message) => {
			logs.push(message)
		},
		writeFile: async (path, contents) => {
			files.set(path, contents)
		},
		...rest,
	}
}

function fakeGh(
	args: ReadonlyArray<string>,
	input: {
		isDraft?: boolean
		commentBody?: string | null
		headSha?: string
		deploymentSha?: string | null
		runStatus?: string
		runConclusion?: string | null
		runUrl?: string
		commitParents?: Array<string>
	},
): GhResult {
	const joined = args.join(' ')
	if (joined.startsWith('pr view')) {
		return jsonGh({
			number: 42,
			url: 'https://github.com/kentcdodds/kody/pull/42',
			isDraft: input.isDraft === true,
			headRefOid: input.headSha ?? 'headsha',
		})
	}
	if (joined.startsWith('repo view')) {
		return jsonGh({ nameWithOwner: 'kentcdodds/kody' })
	}
	if (joined.includes('/issues/') && joined.includes('/comments')) {
		const comments = input.commentBody ? [{ body: input.commentBody }] : []
		if (args.includes('--slurp')) {
			return jsonGh([comments])
		}
		return jsonGh(comments)
	}
	if (joined.startsWith('run list')) {
		return jsonGh([
			{
				databaseId: 1,
				status: input.runStatus ?? 'in_progress',
				conclusion: input.runConclusion ?? null,
				headSha: input.headSha ?? 'headsha',
				event: 'pull_request',
				url:
					input.runUrl ?? 'https://github.com/kentcdodds/kody/actions/runs/1',
				displayTitle: 'Preview #42',
			},
		])
	}
	if (joined.includes('/deployments?')) {
		return jsonGh(
			input.deploymentSha
				? [
						{
							id: 1,
							sha: input.deploymentSha,
							environment: 'preview-42',
						},
					]
				: [],
		)
	}
	if (joined.includes('/commits/')) {
		return jsonGh({
			sha: joined.split('/commits/')[1] ?? '',
			parents: (input.commitParents ?? []).map((sha) => ({ sha })),
		})
	}
	return { status: 1, stdout: '', stderr: `unexpected gh ${joined}` }
}

function jsonGh(value: unknown): GhResult {
	return { status: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' }
}

async function createPreviewFixtureServer(commitSha = 'deployedsha') {
	const server = createServer(
		(request: IncomingMessage, response: ServerResponse) => {
			const url = new URL(request.url ?? '/', 'http://127.0.0.1')
			if (request.method === 'GET' && url.pathname === '/health') {
				json(response, 200, { ok: true, commitSha })
				return
			}
			if (request.method === 'GET' && url.pathname === '/login') {
				response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
				response.end(
					'<h1>Welcome back</h1><label>Email</label><label>Password</label>',
				)
				return
			}
			if (request.method === 'GET' && url.pathname === '/mcp') {
				response.writeHead(401, { 'WWW-Authenticate': 'Bearer' })
				response.end('unauthorized')
				return
			}
			if (request.method === 'POST' && url.pathname === '/auth') {
				response.writeHead(200, {
					'Content-Type': 'application/json',
					'Set-Cookie': 'kody_session=test-cookie; Path=/; HttpOnly',
				})
				response.end(JSON.stringify({ ok: true }))
				return
			}
			if (request.method === 'GET' && url.pathname === '/session') {
				if (!hasSessionCookie(request)) {
					json(response, 200, { ok: false })
					return
				}
				json(response, 200, {
					ok: true,
					session: { email: previewSeedEmail, username: 'user-me' },
				})
				return
			}
			if (request.method === 'GET' && url.pathname === '/admin') {
				response.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' })
				response.end('forbidden')
				return
			}
			if (
				request.method === 'POST' &&
				url.pathname === '/account/values.json'
			) {
				if (!hasSessionCookie(request)) {
					json(response, 401, { ok: false, error: 'Unauthorized.' })
					return
				}
				json(response, 200, { ok: true, selectedValueId: 'preview-locale' })
				return
			}
			if (request.method === 'GET' && url.pathname === '/account/values.json') {
				if (!hasSessionCookie(request)) {
					json(response, 401, { ok: false, error: 'Unauthorized.' })
					return
				}
				json(response, 200, {
					ok: true,
					values: [{ id: 'preview-locale', value: 'en-US' }],
				})
				return
			}
			if (
				request.method === 'GET' &&
				(url.pathname === '/account' || url.pathname === '/account/secrets')
			) {
				if (!hasSessionCookie(request)) {
					response.writeHead(302, { Location: '/login' })
					response.end()
					return
				}
				response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
				response.end('<h1>Account</h1>')
				return
			}
			response.writeHead(404)
			response.end('not found')
		},
	)

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	if (!address || typeof address === 'string') {
		throw new Error('Failed to resolve fixture server port')
	}

	return {
		origin: `http://127.0.0.1:${address.port}`,
		async [Symbol.asyncDispose]() {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error)
					else resolve()
				})
			})
		},
	}
}

function json(response: ServerResponse, status: number, body: unknown) {
	response.writeHead(status, { 'Content-Type': 'application/json' })
	response.end(JSON.stringify(body))
}

function hasSessionCookie(request: IncomingMessage) {
	return (request.headers.cookie ?? '').includes('kody_session=test-cookie')
}
