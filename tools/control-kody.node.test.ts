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
	credentialsForOrigin,
	defaultFeaturesDir,
	defaultRoutesPath,
	formatFeatureMap,
	loginToOrigin,
	localSeedEmail,
	parseControlArgs,
	playwrightBrowsersInstalled,
	isGitAncestor,
	readHealth,
	repoRootFromHere,
	requestAsSession,
	runCommand,
	runDoctor,
	runMapCheck,
	usageLines,
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

test('control-kody parses commands, maps every required route, and drives a seed login', async () => {
	expect(parseControlArgs(['--help']).command).toBe('help')
	expect(parseControlArgs(['map', 'waiting', '--check'])).toEqual(
		expect.objectContaining({
			command: 'map',
			featureId: 'waiting',
			check: true,
		}),
	)
	expect(
		parseControlArgs([
			'request',
			'GET',
			'/account/waiting.json',
			'--origin',
			'http://localhost:3742',
		]).request,
	).toEqual({
		method: 'GET',
		path: '/account/waiting.json',
		expectedStatus: null,
		body: null,
	})
	expect(
		parseControlArgs(['request', 'GET', '/admin', '403', '--skip-login'])
			.request,
	).toEqual({
		method: 'GET',
		path: '/admin',
		expectedStatus: 403,
		body: null,
	})
	expect(
		parseControlArgs([
			'request',
			'GET',
			'/account/waiting',
			'--dump',
			'--contains',
			'Waiting inbox',
			'--contains',
			'<h1>',
		]),
	).toEqual(
		expect.objectContaining({
			command: 'request',
			dump: true,
			dumpFile: '.tmp/control-kody-body',
			contains: ['Waiting inbox', '<h1>'],
		}),
	)
	expect(usageLines.join('\n')).toMatch(/--dump/)
	expect(usageLines.join('\n')).toMatch(/--contains/)
	expect(parseControlArgs(['preview', '--', '--pr', '42']).previewArgv).toEqual(
		['--pr', '42'],
	)
	expect(
		parseControlArgs([
			'package-create',
			'--kody-id',
			'preview-pkg',
			'--description',
			'preview fixture',
			'--head-ahead',
			'--origin',
			'https://kody-pr-9.kody.workers.dev',
			'--json',
		]),
	).toEqual(
		expect.objectContaining({
			command: 'package-create',
			kodyId: 'preview-pkg',
			description: 'preview fixture',
			headAhead: true,
			json: true,
			origin: 'https://kody-pr-9.kody.workers.dev',
		}),
	)
	expect(usageLines.join('\n')).toMatch(/package-create/)
	expect(usageLines.join('\n')).toMatch(/--package-name/)
	expect(usageLines.join('\n')).toMatch(/--head-ahead/)
	expect(() => parseControlArgs(['nope'])).toThrow(/Unknown command/)
	await expect(
		runCommand(
			parseControlArgs(['package-create', '--origin', 'http://127.0.0.1:9']),
		),
	).rejects.toThrow(/requires --package-name/)
	await expect(
		runCommand(
			parseControlArgs([
				'package-create',
				'--kody-id',
				'Not-A-Slug',
				'--origin',
				'http://127.0.0.1:9',
			]),
		),
	).rejects.toThrow(/lower-kebab/)
	await expect(
		runCommand(
			parseControlArgs([
				'package-create',
				'--kody-id',
				'preview-pkg',
				'--origin',
				'https://kody.codes',
			]),
		),
	).rejects.toThrow(/refuses to run against https:\/\/kody\.codes/)
	await expect(
		runCommand(
			parseControlArgs([
				'package-create',
				'--kody-id',
				'preview-pkg',
				'--origin',
				'https://kody.codes.',
			]),
		),
	).rejects.toThrow(/refuses to run against https:\/\/kody\.codes/)

	expect(credentialsForOrigin('http://localhost:3742').email).toBe(
		localSeedEmail,
	)
	expect(credentialsForOrigin('https://kody-pr-9.kody.workers.dev').email).toBe(
		previewSeedEmail,
	)

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

	const doctor = await runDoctor({
		nodeVersion: 'v26.1.2',
		homeDir: tmpdir(),
		hooksPath: '.husky',
		playwrightMarkerExists: () => true,
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
		'health',
		'local-d1',
	])

	const oldNode = await runDoctor({
		nodeVersion: 'v22.14.0',
		homeDir: tmpdir(),
		hooksPath: null,
		playwrightMarkerExists: () => false,
		probeHealth: async () => false,
		ports: [3742],
		origin: null,
		persistRoot: path.join(tmpdir(), 'missing-wrangler-state'),
	})
	expect(oldNode.ok).toBe(false)
	expect(oldNode.checks.find((check) => check.name === 'node')?.detail).toMatch(
		/below 26/,
	)
	expect(playwrightBrowsersInstalled(tmpdir())).toBe(false)

	await withAuthServer(
		(request, response) => {
			const url = request.url ?? '/'
			if (request.method === 'POST' && url === '/auth') {
				response.setHeader('Set-Cookie', 'kody_session=abc; Path=/')
				response.setHeader('Content-Type', 'application/json')
				response.end(JSON.stringify({ ok: true }))
				return
			}
			if (url === '/health') {
				response.setHeader('Content-Type', 'application/json')
				response.end(JSON.stringify({ ok: true, commitSha: 'abc123' }))
				return
			}
			if (url === '/account/waiting.json') {
				if (request.headers.cookie !== 'kody_session=abc') {
					response.statusCode = 401
					response.end('{"ok":false}')
					return
				}
				response.setHeader('Content-Type', 'application/json')
				response.end(JSON.stringify({ items: [] }))
				return
			}
			if (url === '/admin') {
				response.statusCode = 403
				response.end('forbidden')
				return
			}
			response.statusCode = 404
			response.end('missing')
		},
		async (origin) => {
			const session = await loginToOrigin({
				origin,
				email: localSeedEmail,
				password: 'ilikecode',
			})
			expect(session.ok).toBe(true)
			expect(session.cookieHeader).toBe('kody_session=abc')

			const waiting = await requestAsSession({
				origin,
				cookieHeader: session.cookieHeader,
				spec: {
					method: 'GET',
					path: '/account/waiting.json',
					expectedStatus: null,
					body: null,
				},
			})
			expect(waiting.ok).toBe(true)
			expect(waiting.body).toEqual({ items: [] })

			const admin = await requestAsSession({
				origin,
				cookieHeader: session.cookieHeader,
				spec: {
					method: 'GET',
					path: '/admin',
					expectedStatus: 403,
					body: null,
				},
			})
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

test('readHealth accepts a unique short SHA and a descendant live SHA', async () => {
	await withAuthServer(
		(_request, response) => {
			response.setHeader('Content-Type', 'application/json')
			response.end(
				JSON.stringify({
					ok: true,
					commitSha: '91bab582b2040e7b55a84f2415be82c1684ad565',
				}),
			)
		},
		async (origin) => {
			const prefix = await readHealth({
				origin,
				expectedSha: '91bab582',
			})
			expect(prefix.ok).toBe(true)
			expect(prefix.detail).toContain('matches 91bab582')

			const descendant = await readHealth({
				origin,
				expectedSha: 'ab07b020aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				isAncestor: (ancestor, descendantSha) =>
					ancestor === 'ab07b020aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' &&
					descendantSha === '91bab582b2040e7b55a84f2415be82c1684ad565',
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
		isGitAncestor('parent', 'child', {
			execFile: () => Buffer.from(''),
		}),
	).toBe(true)
})

test('doctor local-d1 prints migrate+seed when local seed login fails', async () => {
	const doctor = await runDoctor({
		nodeVersion: 'v26.1.2',
		homeDir: tmpdir(),
		hooksPath: '.husky',
		playwrightMarkerExists: () => true,
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
	expect(doctor.ok).toBe(false)
	expect(
		doctor.checks.find((check) => check.name === 'local-d1')?.detail,
	).toMatch(/npm run migrate:local/)
	expect(
		doctor.checks.find((check) => check.name === 'local-d1')?.detail,
	).toMatch(/node tools\/seed-test-data\.ts --local/)
})

test('control-kody request --dump writes the body and --contains asserts HTML', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'control-kody-dump-'))
	try {
		const dumpFile = path.join(dir, 'control-kody-body')
		await writeFile(dumpFile, 'stale', { mode: 0o644 })
		await chmod(dumpFile, 0o644)
		await withAuthServer(
			(request, response) => {
				const url = request.url ?? '/'
				if (request.method === 'POST' && url === '/auth') {
					response.setHeader('Set-Cookie', 'kody_session=abc; Path=/')
					response.setHeader('Content-Type', 'application/json')
					response.end(JSON.stringify({ ok: true }))
					return
				}
				if (url === '/account/waiting') {
					response.setHeader('Content-Type', 'text/html')
					response.end('<h1>Waiting inbox</h1>')
					return
				}
				response.statusCode = 404
				response.end('missing')
			},
			async (origin) => {
				const cookieFile = path.join(dir, 'cookie')
				const hit = await runCommand({
					...parseControlArgs([
						'request',
						'GET',
						'/account/waiting',
						'--origin',
						origin,
						'--cookie-file',
						cookieFile,
						'--dump',
						'--contains',
						'Waiting inbox',
						'--json',
					]),
					dumpFile,
				})
				expect(hit).toBe(0)
				expect(readFileSync(dumpFile, 'utf8')).toBe('<h1>Waiting inbox</h1>')
				expect(statSync(dumpFile).mode & 0o777).toBe(0o600)

				const missed = await runCommand({
					...parseControlArgs([
						'request',
						'GET',
						'/account/waiting',
						'--origin',
						origin,
						'--cookie-file',
						cookieFile,
						'--contains',
						'No such heading',
						'--json',
					]),
				})
				expect(missed).toBe(1)
			},
		)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('control-kody request --dump and --contains use the raw JSON text', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'control-kody-raw-json-'))
	try {
		const dumpFile = path.join(dir, 'control-kody-body')
		const spaced = '{\n  "ok": true\n}'
		await withAuthServer(
			(request, response) => {
				const url = request.url ?? '/'
				if (request.method === 'POST' && url === '/auth') {
					response.setHeader('Set-Cookie', 'kody_session=abc; Path=/')
					response.setHeader('Content-Type', 'application/json')
					response.end(JSON.stringify({ ok: true }))
					return
				}
				if (url === '/account/waiting.json') {
					response.setHeader('Content-Type', 'application/json')
					response.end(spaced)
					return
				}
				response.statusCode = 404
				response.end('missing')
			},
			async (origin) => {
				const code = await runCommand({
					...parseControlArgs([
						'request',
						'GET',
						'/account/waiting.json',
						'--origin',
						origin,
						'--cookie-file',
						path.join(dir, 'cookie'),
						'--dump',
						'--contains',
						'"ok": true',
						'--json',
					]),
					dumpFile,
				})
				expect(code).toBe(0)
				expect(readFileSync(dumpFile, 'utf8')).toBe(spaced)
			},
		)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('control-kody request re-logs in when a stored cookie is rejected', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'control-kody-stale-cookie-'))
	try {
		const cookieFile = path.join(dir, 'cookie')
		await withAuthServer(
			(request, response) => {
				const url = request.url ?? '/'
				if (request.method === 'POST' && url === '/auth') {
					response.setHeader('Set-Cookie', 'kody_session=fresh; Path=/')
					response.setHeader('Content-Type', 'application/json')
					response.end(JSON.stringify({ ok: true }))
					return
				}
				if (url === '/account/waiting.json') {
					if (request.headers.cookie !== 'kody_session=fresh') {
						response.statusCode = 401
						response.end('{"ok":false}')
						return
					}
					response.setHeader('Content-Type', 'application/json')
					response.end(JSON.stringify({ items: [] }))
					return
				}
				response.statusCode = 404
				response.end('missing')
			},
			async (origin) => {
				await writeFile(
					cookieFile,
					formatCookieFile(origin, 'kody_session=stale'),
				)
				const code = await runCommand(
					parseControlArgs([
						'request',
						'GET',
						'/account/waiting.json',
						'--origin',
						origin,
						'--cookie-file',
						cookieFile,
						'--json',
					]),
				)
				expect(code).toBe(0)
				expect(readFileSync(cookieFile, 'utf8')).toBe(
					formatCookieFile(origin, 'kody_session=fresh'),
				)
			},
		)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('control-kody request re-logs in when HTML redirects to login', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'control-kody-login-html-'))
	try {
		const cookieFile = path.join(dir, 'cookie')
		const loginHtml =
			'<link rel="canonical" href="http://127.0.0.1/login" data-kody-head="canonical" />'
		await withAuthServer(
			(request, response) => {
				const url = request.url ?? '/'
				if (request.method === 'POST' && url === '/auth') {
					response.setHeader('Set-Cookie', 'kody_session=fresh; Path=/')
					response.setHeader('Content-Type', 'application/json')
					response.end(JSON.stringify({ ok: true }))
					return
				}
				if (url === '/account/waiting') {
					if (request.headers.cookie !== 'kody_session=fresh') {
						response.setHeader('Content-Type', 'text/html')
						response.end(loginHtml)
						return
					}
					response.setHeader('Content-Type', 'text/html')
					response.end('<h1>Waiting inbox</h1>')
					return
				}
				response.statusCode = 404
				response.end('missing')
			},
			async (origin) => {
				await writeFile(
					cookieFile,
					formatCookieFile(origin, 'kody_session=stale'),
				)
				const code = await runCommand(
					parseControlArgs([
						'request',
						'GET',
						'/account/waiting',
						'--origin',
						origin,
						'--cookie-file',
						cookieFile,
						'--contains',
						'Waiting inbox',
						'--json',
					]),
				)
				expect(code).toBe(0)
			},
		)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('control-kody login prints migrate+seed when local APP_DB is unready', async () => {
	await withAuthServer(
		(_request, response) => {
			response.statusCode = 500
			response.setHeader('Content-Type', 'application/json')
			response.end(JSON.stringify({ error: 'no such table: users' }))
		},
		async (origin) => {
			const logs: Array<string> = []
			const originalLog = console.log
			console.log = (message?: unknown) => {
				logs.push(String(message))
			}
			try {
				const code = await runCommand(
					parseControlArgs([
						'login',
						'--origin',
						origin,
						'--cookie-file',
						path.join(tmpdir(), 'control-kody-login-unready'),
					]),
				)
				expect(code).toBe(1)
			} finally {
				console.log = originalLog
			}
			expect(logs.join('\n')).toMatch(/npm run migrate:local/)
			expect(logs.join('\n')).toMatch(/node tools\/seed-test-data\.ts --local/)
		},
	)
})

test('control-kody request stops when auto-login fails', async () => {
	await withAuthServer(
		(_request, response) => {
			response.statusCode = 401
			response.setHeader('Content-Type', 'application/json')
			response.end(JSON.stringify({ ok: false }))
		},
		async (origin) => {
			const code = await runCommand(
				parseControlArgs([
					'request',
					'GET',
					'/account/waiting.json',
					'--origin',
					origin,
					'--json',
					'--cookie-file',
					path.join(tmpdir(), 'control-kody-missing-cookie'),
				]),
			)
			expect(code).toBe(1)
		},
	)
})

test('control-kody map --check reports a new /account page as unmapped', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'control-kody-unmapped-'))
	try {
		const files = featureCatalog.map((feature) => feature.file)
		for (const name of files) {
			await writeFile(path.join(dir, name), `# ${name}\n`)
		}
		const report = runMapCheck({
			routeSource: `${readFileSync(defaultRoutesPath(repoRootFromHere()), 'utf8')}
export const extra = '/account/new-surface'`,
			featuresDir: dir,
		})
		expect(report.ok).toBe(false)
		expect(
			report.issues.some(
				(issue) =>
					issue.kind === 'unmapped-route' &&
					issue.path === '/account/new-surface',
			),
		).toBe(true)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('control-kody map --check reports a stale Feature Map path', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'control-kody-map-'))
	try {
		await writeFile(path.join(dir, 'waiting.md'), '# Waiting\n')
		const report = runMapCheck({
			routeSource: `export const routes = { waiting: '/account/waiting' }`,
			featuresDir: dir,
		})
		expect(report.ok).toBe(false)
		expect(report.issues.some((issue) => issue.kind === 'missing-file')).toBe(
			true,
		)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
