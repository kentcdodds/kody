import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import {
	credentialsForOrigin,
	defaultFeaturesDir,
	defaultRoutesPath,
	formatFeatureMap,
	loginToOrigin,
	localSeedEmail,
	parseControlArgs,
	playwrightBrowsersInstalled,
	readHealth,
	repoRootFromHere,
	requestAsSession,
	runCommand,
	runDoctor,
	runMapCheck,
} from './control-kody.ts'
import { previewSeedEmail } from './preview-manual-test.ts'
import { featureCatalog } from './control-kody/feature-catalog.ts'

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
	expect(parseControlArgs(['preview', '--', '--pr', '42']).previewArgv).toEqual(
		['--pr', '42'],
	)
	expect(() => parseControlArgs(['nope'])).toThrow(/Unknown command/)

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
	})
	expect(doctor.ok).toBe(true)
	expect(doctor.checks.map((check) => check.name)).toEqual([
		'node',
		'playwright',
		'hooks',
		'health',
	])

	const oldNode = await runDoctor({
		nodeVersion: 'v22.14.0',
		homeDir: tmpdir(),
		hooksPath: null,
		playwrightMarkerExists: () => false,
		probeHealth: async () => false,
		ports: [3742],
		origin: null,
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
