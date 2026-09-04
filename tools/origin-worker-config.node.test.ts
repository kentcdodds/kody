import { expect, test } from 'vitest'
import {
	isOriginWorkerConfigPath,
	omitConfigFlag,
	omitNameFlag,
	readConfigFlag,
	readNameFlag,
} from './origin-worker-config.ts'

test('treats the committed worker config and generated origin configs as origin', () => {
	expect(isOriginWorkerConfigPath(undefined)).toBe(true)
	expect(isOriginWorkerConfigPath('packages/worker/wrangler.jsonc')).toBe(true)
	expect(
		isOriginWorkerConfigPath(
			'packages/worker/wrangler-production.generated.json',
		),
	).toBe(true)
	expect(
		isOriginWorkerConfigPath('packages/worker/wrangler-preview.generated.json'),
	).toBe(true)
})

test('rejects sibling fleet and mock worker configs', () => {
	expect(
		isOriginWorkerConfigPath(
			'packages/platform-worker/wrangler-production.generated.json',
		),
	).toBe(false)
	expect(
		isOriginWorkerConfigPath(
			'packages/runtime-worker/wrangler-production.generated.json',
		),
	).toBe(false)
	expect(isOriginWorkerConfigPath('packages/jobs-worker/wrangler.jsonc')).toBe(
		false,
	)
	expect(
		isOriginWorkerConfigPath('packages/highlight-worker/wrangler.jsonc'),
	).toBe(false)
	expect(
		isOriginWorkerConfigPath('packages/mock-servers/cloudflare/wrangler.jsonc'),
	).toBe(false)
})

test('reads and strips --config flags', () => {
	expect(
		readConfigFlag([
			'--config',
			'packages/worker/wrangler-production.generated.json',
			'--var',
			'APP_COMMIT_SHA:abc',
		]),
	).toBe('packages/worker/wrangler-production.generated.json')
	expect(
		omitConfigFlag([
			'--config',
			'packages/worker/wrangler-production.generated.json',
			'--var',
			'APP_COMMIT_SHA:abc',
		]),
	).toEqual(['--var', 'APP_COMMIT_SHA:abc'])
	expect(
		omitConfigFlag([
			'--config=packages/worker/wrangler.jsonc',
			'--upload-source-maps',
		]),
	).toEqual(['--upload-source-maps'])
})

test('reads and strips --name flags', () => {
	expect(
		readNameFlag(['--name', 'kody-production', '--var', 'APP_COMMIT_SHA:abc']),
	).toBe('kody-production')
	expect(readNameFlag(['--name=kody-pr-2055'])).toBe('kody-pr-2055')
	expect(
		omitNameFlag(['--name', 'kody-production', '--var', 'APP_COMMIT_SHA:abc']),
	).toEqual(['--var', 'APP_COMMIT_SHA:abc'])
})
