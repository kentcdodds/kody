import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import {
	controlKodyUserAgent,
	credentialsForOrigin,
	defaultFeaturesDir,
	defaultRoutesPath,
	formatFeatureMap,
	loginToOrigin,
	localSeedEmail,
	parseControlArgs,
	isGitAncestor,
	readHealth,
	repoRootFromHere,
	requestAsSession,
	runCommand,
	runDoctor,
	runMapCheck,
} from './control-kody.ts'
import { previewSeedEmail } from './preview-manual-test.ts'
import { featureCatalog } from './control-kody/feature-catalog.ts'
import { formatCookieFile } from './control-kody/session-cookie.ts'

async function withAuthServer(
	handler: (request: IncomingMessage, response: ServerResponse) => void,
	run: (origin: string) => Promise<void>,
) {
	const server = createServer(handler)
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve)
	})
	const address = server.address()
	if (!address || typeof address === 'string') {
		throw new Error('expected TCP address')
	}
	try {
		await run(`http://127.0.0.1:${address.port}`)
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) reject(error)
				else resolve()
			})
		})
	}
}

function send(
	response: ServerResponse,
	contentType: 'application/json' | 'text/html',
	body: string,
	status = 200,
) {
	response.statusCode = status
	response.setHeader('Content-Type', contentType)
	response.end(body)
}

/** Handles `POST /auth` by issuing `cookie`; returns true when it did. */
function handleAuth(
	request: IncomingMessage,
	response: ServerResponse,
	cookie: string,
) {
	if (request.method !== 'POST' || request.url !== '/auth') return false
	response.setHeader('Set-Cookie', `${cookie}; Path=/`)
	send(response, 'application/json', JSON.stringify({ ok: true }))
	return true
}

function notFound(response: ServerResponse) {
	response.statusCode = 404
	response.end('missing')
}

async function createTempDir() {
	const dir = await mkdtemp(path.join(tmpdir(), 'control-kody-'))
	return {
		dir,
		[Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }),
	}
}

const requestArgv = (
	method: string,
	requestPath: string,
	origin: string,
	cookieFile: string,
	...extra: Array<string>
) =>
	parseControlArgs([
		'request',
		method,
		requestPath,
		'--origin',
		origin,
		'--cookie-file',
		cookieFile,
		...extra,
		'--json',
	])

const playwrightOk = () => ({
	ok: true,
	detail:
		'Playwright chromium-1234 and chromium_headless_shell-1234 INSTALLATION_COMPLETE',
})

test('control-kody parses commands, maps every required route, and drives a seed login', async () => {
	expect(parseControlArgs(['--help']).command).toBe('help')
	const request = (argv: Array<string>) => parseControlArgs(argv).request
	const plainRequest = { body: null, dump: false, contains: [] }
	expect(
		request([
			'request',
			'GET',
			'/account/waiting.json',
			'--origin',
			'http://localhost:3742',
		]),
	).toEqual({
		...plainRequest,
		method: 'GET',
		path: '/account/waiting.json',
		expectedStatus: null,
	})
	expect(request(['request', 'GET', '/admin', '403', '--skip-login'])).toEqual({
		...plainRequest,
		method: 'GET',
		path: '/admin',
		expectedStatus: 403,
	})
	expect(
		request([
			'request',
			'POST',
			'/account/secrets.json',
			'400',
			'{"action":"add","scope":"user","name":"badSeed","value":"unused"}',
		]),
	).toEqual({
		...plainRequest,
		method: 'POST',
		path: '/account/secrets.json',
		expectedStatus: 400,
		body: { action: 'add', scope: 'user', name: 'badSeed', value: 'unused' },
	})
	expect(parseControlArgs(['preview', '--', '--pr', '42']).previewArgv).toEqual(
		['--pr', '42'],
	)
	expect(
		parseControlArgs('preview --pr 42 --check /account/waiting'.split(' '))
			.previewArgv,
	).toEqual(['--pr', '42', '--check', '/account/waiting'])

	const preview = 'https://kody-pr-9.kody.workers.dev'
	const parsed: Array<[Array<string>, Record<string, unknown>]> = [
		[
			['map', 'waiting', '--check'],
			{ command: 'map', featureId: 'waiting', check: true },
		],
		[
			[
				'request',
				'GET',
				'/account/waiting',
				'--dump',
				'--contains',
				'Waiting inbox',
				'--contains',
				'<h1>',
			],
			{
				command: 'request',
				dump: true,
				dumpFile: '.tmp/control-kody-body',
				contains: ['Waiting inbox', '<h1>'],
			},
		],
		[
			[
				'package-create',
				'--kody-id',
				'preview-pkg',
				'--description',
				'preview fixture',
				'--head-ahead',
				'--origin',
				preview,
				'--json',
			],
			{
				command: 'package-create',
				kodyId: 'preview-pkg',
				description: 'preview fixture',
				headAhead: true,
				json: true,
				origin: preview,
			},
		],
		[
			`execute --code-file fixture.ts --params-file params.json --origin ${preview} --json`.split(
				' ',
			),
			{
				command: 'execute',
				codeFile: 'fixture.ts',
				paramsFile: 'params.json',
				json: true,
				origin: preview,
			},
		],
		[
			'search --query packageSave --domain packages --entity capability:packageSave --limit 5'.split(
				' ',
			),
			{
				command: 'search',
				query: 'packageSave',
				domain: 'packages',
				entity: 'capability:packageSave',
				limit: 5,
			},
		],
	]
	for (const [argv, expected] of parsed) {
		expect(parseControlArgs(argv)).toEqual(expect.objectContaining(expected))
	}

	const parseErrors: Array<[string, RegExp]> = [
		[
			'search --query packageSave --limit 10garbage',
			/--limit must be a positive integer/,
		],
		[
			'search --query packageSave --limit 1.5',
			/--limit must be a positive integer/,
		],
		['nope', /Unknown command/],
	]
	for (const [argv, error] of parseErrors) {
		expect(() => parseControlArgs(argv.split(' '))).toThrow(error)
	}

	const production = /refuses to run against https:\/\/kody\.codes/
	const runErrors: Array<[string, RegExp]> = [
		['package-create --origin http://127.0.0.1:9', /requires --package-name/],
		[
			'package-create --kody-id Not-A-Slug --origin http://127.0.0.1:9',
			/lower-kebab/,
		],
		[
			'package-create --kody-id preview-pkg --origin https://kody.codes',
			production,
		],
		[
			'package-create --kody-id preview-pkg --origin https://kody.codes.',
			production,
		],
		[`execute --origin ${preview}`, /requires --code-file/],
		['execute --code-file fixture.ts --origin https://kody.codes', production],
		[
			'search --origin http://127.0.0.1:9',
			/requires --query, --entity, or --domain/,
		],
		['search --query packageSave --origin https://kody.codes', production],
	]
	for (const [argv, error] of runErrors) {
		await expect(runCommand(parseControlArgs(argv.split(' ')))).rejects.toThrow(
			error,
		)
	}

	expect(credentialsForOrigin('http://localhost:3742').email).toBe(
		localSeedEmail,
	)
	expect(credentialsForOrigin(preview).email).toBe(previewSeedEmail)

	const root = repoRootFromHere()
	const report = runMapCheck({
		routeSource: readFileSync(defaultRoutesPath(root), 'utf8'),
		featuresDir: defaultFeaturesDir(root),
	})
	expect(report.issues).toEqual([])
	expect(report.ok).toBe(true)
	expect(formatFeatureMap(featureCatalog)).toContain(
		'waiting\t/account/waiting',
	)
	expect(
		readdirSync(defaultFeaturesDir(root)).filter((name) =>
			name.endsWith('.md'),
		),
	).toEqual(
		expect.arrayContaining(featureCatalog.map((feature) => feature.file)),
	)

	await withAuthServer(
		(request, response) => {
			if (handleAuth(request, response, 'kody_session=abc')) return
			const url = request.url ?? '/'
			if (url === '/health') {
				send(
					response,
					'application/json',
					JSON.stringify({ ok: true, commitSha: 'abc123' }),
				)
			} else if (url === '/account/waiting.json') {
				if (request.headers.cookie !== 'kody_session=abc') {
					send(response, 'application/json', '{"ok":false}', 401)
				} else {
					send(response, 'application/json', JSON.stringify({ items: [] }))
				}
			} else if (url === '/admin') {
				response.statusCode = 403
				response.end('forbidden')
			} else {
				notFound(response)
			}
		},
		async (origin) => {
			const session = await loginToOrigin({
				origin,
				email: localSeedEmail,
				password: 'ilikecode',
			})
			expect(session.ok).toBe(true)
			expect(session.cookieHeader).toBe('kody_session=abc')

			const asSession = (path: string, expectedStatus: number | null) =>
				requestAsSession({
					origin,
					cookieHeader: session.cookieHeader,
					spec: { ...plainRequest, method: 'GET', path, expectedStatus },
				})
			const waiting = await asSession('/account/waiting.json', null)
			expect(waiting.ok).toBe(true)
			expect(waiting.body).toEqual({ items: [] })
			const admin = await asSession('/admin', 403)
			expect(admin.ok).toBe(true)
			expect(admin.status).toBe(403)

			const health = await readHealth({ origin, expectedSha: 'abc123' })
			expect(health.ok).toBe(true)
			expect(health.commitSha).toBe('abc123')
			const stale = await readHealth({ origin, expectedSha: 'fff' })
			expect(stale.ok).toBe(false)
		},
	)
})

test('runDoctor reports node, playwright, hooks, deps, health, and local-d1 checks', async () => {
	const depsOk = {
		ok: true,
		detail: 'installed dependencies match package-lock.json',
	}
	const doctor = await runDoctor({
		nodeVersion: 'v26.1.2',
		homeDir: tmpdir(),
		hooksPath: '.husky',
		inspectPlaywright: playwrightOk,
		inspectInstalledLockfile: () => depsOk,
		probeHealth: async () => true,
		ports: [3742],
		origin: 'http://localhost:3742',
		persistRoot: tmpdir(),
		probeLocalLogin: async () => ({
			ok: true,
			status: 200,
			detail: 'signed in as jane@example.com',
			email: 'jane@example.com',
		}),
	})
	expect(doctor.ok).toBe(true)
	expect(doctor.checks.map((check) => check.name)).toEqual([
		'node',
		'playwright',
		'hooks',
		'deps',
		'health',
		'local-d1',
	])
	expect(doctor.checks.find((check) => check.name === 'playwright')).toEqual({
		name: 'playwright',
		...playwrightOk(),
	})

	const missingPlaywright =
		'Playwright revision missing (chromium-1234, chromium_headless_shell-1234). Unzip per docs/contributing/cloud-agents.md.'
	const oldNode = await runDoctor({
		nodeVersion: 'v22.14.0',
		homeDir: tmpdir(),
		hooksPath: null,
		inspectPlaywright: () => ({ ok: false, detail: missingPlaywright }),
		inspectInstalledLockfile: () => depsOk,
		probeHealth: async () => false,
		ports: [3742],
		origin: null,
		persistRoot: path.join(tmpdir(), 'missing-wrangler-state'),
	})
	expect(oldNode.ok).toBe(false)
	expect(oldNode.checks.find((check) => check.name === 'node')?.detail).toMatch(
		/below 26/,
	)
	expect(oldNode.checks.find((check) => check.name === 'playwright')).toEqual({
		name: 'playwright',
		ok: false,
		detail: missingPlaywright,
	})

	const failedLogin = await runDoctor({
		nodeVersion: 'v26.1.2',
		homeDir: tmpdir(),
		hooksPath: '.husky',
		inspectPlaywright: playwrightOk,
		inspectInstalledLockfile: () => depsOk,
		probeHealth: async () => true,
		ports: [3742],
		origin: 'http://localhost:3742',
		persistRoot: path.join(tmpdir(), 'missing-wrangler-state'),
		probeLocalLogin: async () => ({
			ok: false,
			status: 500,
			detail: 'HTTP 500 no such table: users',
			email: 'jane@example.com',
		}),
	})
	expect(failedLogin.ok).toBe(false)
	expect(
		failedLogin.checks.some((check) => check.name === 'local-d1' && !check.ok),
	).toBe(true)

	const staleInstall = await runDoctor({
		nodeVersion: 'v26.1.2',
		homeDir: tmpdir(),
		hooksPath: '.husky',
		inspectPlaywright: playwrightOk,
		inspectInstalledLockfile: () => ({
			ok: false,
			detail:
				'Installed dependencies do not match package-lock.json. Run `npm ci`.',
		}),
		probeHealth: async () => true,
		ports: [3742],
		origin: null,
		persistRoot: tmpdir(),
	})
	expect(staleInstall.ok).toBe(false)
	expect(staleInstall.checks.find((check) => check.name === 'deps')?.ok).toBe(
		false,
	)

	const unreadableLockfile = await runDoctor({
		nodeVersion: 'v26.1.2',
		homeDir: tmpdir(),
		hooksPath: '.husky',
		inspectPlaywright: playwrightOk,
		inspectInstalledLockfile: async () => {
			throw new Error('Unexpected end of JSON input')
		},
		probeHealth: async () => true,
		ports: [3742],
		origin: null,
		persistRoot: tmpdir(),
	})
	expect(unreadableLockfile.ok).toBe(false)
	expect(
		unreadableLockfile.checks.find((check) => check.name === 'deps'),
	).toEqual({
		name: 'deps',
		ok: false,
		detail:
			'Could not inspect package-lock.json: Unexpected end of JSON input. Check that the file is readable and valid JSON.',
	})
	expect(
		unreadableLockfile.checks.some((check) => check.name === 'health'),
	).toBe(true)
})

test('readHealth accepts a unique short SHA and a descendant live SHA', async () => {
	const liveSha = '91bab582b2040e7b55a84f2415be82c1684ad565'
	await withAuthServer(
		(_request, response) => {
			send(
				response,
				'application/json',
				JSON.stringify({ ok: true, commitSha: liveSha }),
			)
		},
		async (origin) => {
			const prefix = await readHealth({ origin, expectedSha: '91bab582' })
			expect(prefix.ok).toBe(true)
			expect(prefix.detail).toContain('matches 91bab582')

			const expectedSha = 'ab07b020aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
			const descendant = await readHealth({
				origin,
				expectedSha,
				isAncestor: (ancestor, descendantSha) =>
					ancestor === expectedSha && descendantSha === liveSha,
			})
			expect(descendant.ok).toBe(true)
			expect(descendant.detail).toContain('descendant of')

			const unrelated = await readHealth({
				origin,
				expectedSha: 'ffffffffffffffffffffffffffffffffffffffff',
				isAncestor: () => false,
			})
			expect(unrelated.ok).toBe(false)
		},
	)

	expect(
		isGitAncestor('missing', 'also-missing', {
			execFile: () => {
				throw new Error('not an ancestor')
			},
		}),
	).toBe(false)
	expect(
		isGitAncestor('parent', 'child', { execFile: () => Buffer.from('') }),
	).toBe(true)
})

test('control-kody request --dump writes the raw body and --contains asserts HTML and JSON text', async () => {
	await using temp = await createTempDir()
	const dumpFile = path.join(temp.dir, 'control-kody-body')
	await writeFile(dumpFile, 'stale', { mode: 0o644 })
	await chmod(dumpFile, 0o644)
	const cookieFile = path.join(temp.dir, 'cookie')
	const spaced = '{\n  "ok": true\n}'
	await withAuthServer(
		(request, response) => {
			if (handleAuth(request, response, 'kody_session=abc')) return
			if (request.url === '/account/waiting') {
				send(response, 'text/html', '<h1>Waiting inbox</h1>')
			} else if (request.url === '/account/waiting.json') {
				send(response, 'application/json', spaced)
			} else {
				notFound(response)
			}
		},
		async (origin) => {
			const html = (...extra: Array<string>) =>
				requestArgv('GET', '/account/waiting', origin, cookieFile, ...extra)
			expect(
				await runCommand({
					...html('--dump', '--contains', 'Waiting inbox'),
					dumpFile,
				}),
			).toBe(0)
			expect(readFileSync(dumpFile, 'utf8')).toBe('<h1>Waiting inbox</h1>')
			expect(statSync(dumpFile).mode & 0o777).toBe(0o600)
			expect(await runCommand(html('--contains', 'No such heading'))).toBe(1)

			expect(
				await runCommand({
					...requestArgv(
						'GET',
						'/account/waiting.json',
						origin,
						cookieFile,
						'--dump',
						'--contains',
						'"ok": true',
					),
					dumpFile,
				}),
			).toBe(0)
			expect(readFileSync(dumpFile, 'utf8')).toBe(spaced)
		},
	)
})

test('control-kody request re-logs in when a stored cookie is rejected or HTML redirects to login', async () => {
	await using temp = await createTempDir()
	const cookieFile = path.join(temp.dir, 'cookie')
	await withAuthServer(
		(request, response) => {
			if (handleAuth(request, response, 'kody_session=fresh')) return
			const fresh = request.headers.cookie === 'kody_session=fresh'
			if (request.url === '/account/waiting.json') {
				if (fresh) {
					send(response, 'application/json', JSON.stringify({ items: [] }))
				} else {
					send(response, 'application/json', '{"ok":false}', 401)
				}
			} else if (request.url === '/account/waiting') {
				send(
					response,
					'text/html',
					fresh
						? '<h1>Waiting inbox</h1>'
						: '<link rel="canonical" href="http://127.0.0.1/login" data-kody-head="canonical" />',
				)
			} else {
				notFound(response)
			}
		},
		async (origin) => {
			await writeFile(
				cookieFile,
				formatCookieFile(origin, 'kody_session=stale'),
			)
			expect(
				await runCommand(
					requestArgv('GET', '/account/waiting.json', origin, cookieFile),
				),
			).toBe(0)
			expect(readFileSync(cookieFile, 'utf8')).toBe(
				formatCookieFile(origin, 'kody_session=fresh', 'jane@example.com'),
			)

			await writeFile(
				cookieFile,
				formatCookieFile(origin, 'kody_session=stale'),
			)
			expect(
				await runCommand(
					requestArgv(
						'GET',
						'/account/waiting',
						origin,
						cookieFile,
						'--contains',
						'Waiting inbox',
					),
				),
			).toBe(0)
		},
	)
})

test('control-kody request --email does not reuse another user cookie for the same origin', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'control-kody-email-cookie-'))
	try {
		const cookieFile = path.join(dir, 'cookie')
		const seen: Array<{ url?: string; cookie?: string; email?: string }> = []
		await withAuthServer(
			(request, response) => {
				const url = request.url ?? '/'
				if (request.method === 'POST' && url === '/auth') {
					const chunks: Array<Buffer> = []
					request.on('data', (chunk: Buffer | string) => {
						chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
					})
					request.on('end', () => {
						const body = Buffer.concat(chunks).toString()
						const email = (JSON.parse(body) as { email?: string }).email ?? ''
						seen.push({ url, email })
						response.setHeader(
							'Set-Cookie',
							`kody_session=${email === 'jane@example.com' ? 'jane' : 'other'}; Path=/`,
						)
						response.setHeader('Content-Type', 'application/json')
						response.end(JSON.stringify({ ok: true }))
					})
					return
				}
				if (url === '/account/usage.json') {
					seen.push({ url, cookie: request.headers.cookie })
					response.setHeader('Content-Type', 'application/json')
					response.end(
						JSON.stringify({
							session: request.headers.cookie,
						}),
					)
					return
				}
				response.statusCode = 404
				response.end('missing')
			},
			async (origin) => {
				await writeFile(
					cookieFile,
					formatCookieFile(origin, 'kody_session=admin', 'kody@example.com'),
				)
				const code = await runCommand(
					parseControlArgs([
						'request',
						'GET',
						'/account/usage.json',
						'--origin',
						origin,
						'--email',
						'jane@example.com',
						'--password',
						'ilikecode',
						'--cookie-file',
						cookieFile,
						'--json',
					]),
				)
				expect(code).toBe(0)
				expect(seen).toEqual([
					{ url: '/auth', email: 'jane@example.com' },
					{ url: '/account/usage.json', cookie: 'kody_session=jane' },
				])
				expect(readFileSync(cookieFile, 'utf8')).toBe(
					formatCookieFile(origin, 'kody_session=jane', 'jane@example.com'),
				)
			},
		)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('control-kody request --skip-login --email does not reuse another user cookie', async () => {
	const dir = await mkdtemp(
		path.join(tmpdir(), 'control-kody-skip-login-email-'),
	)
	try {
		const cookieFile = path.join(dir, 'cookie')
		const seen: Array<{ url?: string; cookie?: string }> = []
		await withAuthServer(
			(request, response) => {
				const url = request.url ?? '/'
				if (url === '/admin') {
					seen.push({ url, cookie: request.headers.cookie })
					response.statusCode = request.headers.cookie ? 200 : 403
					response.setHeader('Content-Type', 'text/plain')
					response.end(request.headers.cookie ? 'admin' : 'forbidden')
					return
				}
				response.statusCode = 404
				response.end('missing')
			},
			async (origin) => {
				await writeFile(
					cookieFile,
					formatCookieFile(origin, 'kody_session=jane', 'jane@example.com'),
				)
				const code = await runCommand(
					parseControlArgs([
						'request',
						'GET',
						'/admin',
						'403',
						'--origin',
						origin,
						'--email',
						'kody@example.com',
						'--skip-login',
						'--cookie-file',
						cookieFile,
						'--json',
					]),
				)
				expect(code).toBe(0)
				expect(seen).toEqual([{ url: '/admin', cookie: undefined }])
				expect(readFileSync(cookieFile, 'utf8')).toBe(
					formatCookieFile(origin, 'kody_session=jane', 'jane@example.com'),
				)
			},
		)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('control-kody request logs in before a mutating call when no cookie exists', async () => {
	await using temp = await createTempDir()
	const seen: Array<{ method?: string; url?: string; cookie?: string }> = []
	await withAuthServer(
		(request, response) => {
			seen.push({
				method: request.method,
				url: request.url ?? '/',
				cookie: request.headers.cookie,
			})
			if (handleAuth(request, response, 'kody_session=fresh')) return
			if (request.url === '/docs/secret-providers/opt-in') {
				if (request.headers.cookie !== 'kody_session=fresh') {
					response.statusCode = 302
					response.setHeader('Location', '/login')
					response.end()
					return
				}
				send(
					response,
					'application/json',
					JSON.stringify({ ok: true, optedIn: true }),
				)
			} else if (request.url === '/login') {
				send(
					response,
					'text/html',
					'<link rel="canonical" href="http://127.0.0.1/login" data-kody-head="canonical" />',
				)
			} else {
				notFound(response)
			}
		},
		async (origin) => {
			const code = await runCommand(
				requestArgv(
					'POST',
					'/docs/secret-providers/opt-in',
					origin,
					path.join(temp.dir, 'cookie'),
				),
			)
			expect(code).toBe(0)
			expect(seen[0]).toEqual(
				expect.objectContaining({ method: 'POST', url: '/auth' }),
			)
			const optInCookies = seen
				.filter(
					(hit) =>
						hit.method === 'POST' &&
						hit.url === '/docs/secret-providers/opt-in',
				)
				.map((hit) => hit.cookie)
			expect(optInCookies).toContain('kody_session=fresh')
			expect(optInCookies.filter((cookie) => !cookie)).toEqual([])
		},
	)
})

test('control-kody request fetches public HTML without posting /auth and stops when auto-login fails', async () => {
	await using temp = await createTempDir()
	const seen: Array<{ method?: string; url?: string; ua?: string }> = []
	await withAuthServer(
		(request, response) => {
			seen.push({
				method: request.method,
				url: request.url ?? '/',
				ua: request.headers['user-agent'],
			})
			if (request.method === 'POST' && request.url === '/auth') {
				send(
					response,
					'application/json',
					JSON.stringify({
						error: 'Please complete the human verification challenge.',
					}),
					400,
				)
			} else if (request.url === '/pricing') {
				send(response, 'text/html', '<h1>Automation invocations per day</h1>')
			} else {
				notFound(response)
			}
		},
		async (origin) => {
			const code = await runCommand(
				requestArgv(
					'GET',
					'/pricing',
					origin,
					path.join(temp.dir, 'cookie'),
					'--contains',
					'Automation invocations per day',
				),
			)
			expect(code).toBe(0)
			expect(
				seen.some((hit) => hit.method === 'POST' && hit.url === '/auth'),
			).toBe(false)
			expect(
				seen.some(
					(hit) =>
						hit.method === 'GET' &&
						hit.url === '/pricing' &&
						hit.ua === controlKodyUserAgent,
				),
			).toBe(true)
		},
	)

	await withAuthServer(
		(_request, response) => {
			send(response, 'application/json', JSON.stringify({ ok: false }), 401)
		},
		async (origin) => {
			const code = await runCommand(
				requestArgv(
					'GET',
					'/account/waiting.json',
					origin,
					path.join(temp.dir, 'missing-cookie'),
				),
			)
			expect(code).toBe(1)
		},
	)
})

test('control-kody map --check reports unmapped /account pages and stale Feature Map paths', async () => {
	await using temp = await createTempDir()
	for (const feature of featureCatalog) {
		await writeFile(path.join(temp.dir, feature.file), `# ${feature.file}\n`)
	}
	const unmapped = runMapCheck({
		routeSource: `${readFileSync(defaultRoutesPath(repoRootFromHere()), 'utf8')}
export const extra = '/account/new-surface'`,
		featuresDir: temp.dir,
	})
	expect(unmapped.ok).toBe(false)
	expect(
		unmapped.issues.some(
			(issue) =>
				issue.kind === 'unmapped-route' &&
				issue.path === '/account/new-surface',
		),
	).toBe(true)

	await using staleDir = await createTempDir()
	await writeFile(path.join(staleDir.dir, 'waiting.md'), '# Waiting\n')
	const stale = runMapCheck({
		routeSource: `export const routes = { waiting: '/account/waiting' }`,
		featuresDir: staleDir.dir,
	})
	expect(stale.ok).toBe(false)
	expect(stale.issues.some((issue) => issue.kind === 'missing-file')).toBe(true)
})
