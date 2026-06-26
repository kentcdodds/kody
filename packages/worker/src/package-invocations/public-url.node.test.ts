import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { buildExternalPackageInvocationDescriptor } from './public-url.ts'

const currentDir = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(currentDir, '../../../..')

test('canonical package invocation descriptor includes owner slug and normalized export names', () => {
	const descriptor = buildExternalPackageInvocationDescriptor({
		baseUrl: 'https://heykody.dev',
		ownerUsername: 'kentcdodds',
		kodyId: 'youtube-livestream-vod-manager',
		exportName: './process-video',
	})

	expect(descriptor).toMatchObject({
		method: 'POST',
		url: 'https://heykody.dev/@kentcdodds/api/package-invocations/youtube-livestream-vod-manager/process-video',
		path: '/@kentcdodds/api/package-invocations/youtube-livestream-vod-manager/process-video',
		ownerUsername: 'kentcdodds',
		kodyId: 'youtube-livestream-vod-manager',
		routeExportName: 'process-video',
		normalizedExportName: './process-video',
		tokenSetupUrl:
			'https://heykody.dev/account/package-invocation-tokens/new?packageKodyIds=youtube-livestream-vod-manager&exportNames=process-video',
	})
	expect(descriptor.sourceGuidance).toContain('"source"')
})

test('canonical root export invocation descriptor uses a URL-safe route segment', () => {
	const descriptor = buildExternalPackageInvocationDescriptor({
		baseUrl: 'https://heykody.dev',
		ownerUsername: 'kentcdodds',
		kodyId: 'discord-gateway',
		exportName: '.',
	})

	expect(descriptor).toMatchObject({
		url: 'https://heykody.dev/@kentcdodds/api/package-invocations/discord-gateway/__root__',
		path: '/@kentcdodds/api/package-invocations/discord-gateway/__root__',
		routeExportName: '__root__',
		normalizedExportName: '.',
		tokenSetupUrl:
			'https://heykody.dev/account/package-invocation-tokens/new?packageKodyIds=discord-gateway&exportNames=.',
	})
})

test('documented full invocation URL examples are owner scoped', async () => {
	const paths = [
		'docs/guides/account-package-invocation-token-setup.md',
		'docs/contributing/package-invocation-api.md',
	]
	const urlPattern =
		/https?:\/\/[^\s"'`]+\/api\/package-invocations\/[^\s"'`]+/g

	for (const path of paths) {
		const text = await readFile(resolve(workspaceRoot, path), 'utf8')
		const urls = text.match(urlPattern) ?? []
		for (const url of urls) {
			expect(url, `${path} should use owner-scoped invocation URLs`).toMatch(
				/\/@[^/]+\/api\/package-invocations\//,
			)
		}
	}
})
