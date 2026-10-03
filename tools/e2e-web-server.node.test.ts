import { expect, test } from 'vitest'
import {
	defaultE2eWebServerPort,
	findUnhealthyOriginDevServerMessage,
	formatUnhealthyOriginDevServerHint,
	resolveE2eWebServerHealthUrl,
	shouldRetryE2eWebServerFirstStart,
} from './e2e-web-server.ts'

test('e2e webServer retries the first Vite process only before /health', () => {
	expect(resolveE2eWebServerHealthUrl([])).toBe(
		`http://127.0.0.1:${defaultE2eWebServerPort}/health`,
	)
	expect(resolveE2eWebServerHealthUrl(['--port', '3847'])).toBe(
		'http://127.0.0.1:3847/health',
	)
	expect(resolveE2eWebServerHealthUrl(['--port', '--strictPort'])).toBe(
		`http://127.0.0.1:${defaultE2eWebServerPort}/health`,
	)

	expect(
		shouldRetryE2eWebServerFirstStart({
			allowRetry: true,
			shuttingDown: false,
			servedHealth: false,
			exitCode: 1,
		}),
	).toBe(true)
	expect(
		shouldRetryE2eWebServerFirstStart({
			allowRetry: true,
			shuttingDown: false,
			servedHealth: true,
			exitCode: 1,
		}),
	).toBe(false)
	expect(
		shouldRetryE2eWebServerFirstStart({
			allowRetry: false,
			shuttingDown: false,
			servedHealth: false,
			exitCode: 1,
		}),
	).toBe(false)
	expect(
		shouldRetryE2eWebServerFirstStart({
			allowRetry: true,
			shuttingDown: true,
			servedHealth: false,
			exitCode: 1,
		}),
	).toBe(false)
	expect(
		shouldRetryE2eWebServerFirstStart({
			allowRetry: true,
			shuttingDown: false,
			servedHealth: false,
			exitCode: 0,
		}),
	).toBe(false)
})

test('e2e webServer names an unhealthy leftover origin before starting Vite', async () => {
	const identity = { pid: 9, ppid: 1, comm: 'workerd', cmdline: 'workerd' }
	const hint = formatUnhealthyOriginDevServerHint()

	expect(
		await findUnhealthyOriginDevServerMessage({
			ports: [3742],
			probeHealth: async () => false,
			listListenerPids: () => [9],
			readProcess: () => identity,
			protectedPids: new Set(),
		}),
	).toBe(hint)

	expect(
		await findUnhealthyOriginDevServerMessage({
			ports: [3742],
			probeHealth: async () => true,
			listListenerPids: () => [9],
			readProcess: () => identity,
			protectedPids: new Set(),
		}),
	).toBeNull()

	expect(
		await findUnhealthyOriginDevServerMessage({
			ports: [3742],
			probeHealth: async () => false,
			listListenerPids: () => [],
			readProcess: () => null,
			protectedPids: new Set(),
		}),
	).toBeNull()
})
