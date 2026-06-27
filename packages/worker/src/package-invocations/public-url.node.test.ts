import { expect, test } from 'vitest'
import { buildExternalPackageInvocationDescriptor } from './public-url.ts'

test('buildExternalPackageInvocationDescriptor normalizes subpath and root exports', () => {
	const subpathDescriptor = buildExternalPackageInvocationDescriptor({
		baseUrl: 'https://heykody.dev',
		ownerUsername: 'kentcdodds',
		kodyId: 'youtube-livestream-vod-manager',
		exportName: './process-video',
	})

	expect(subpathDescriptor).toMatchObject({
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
	expect(subpathDescriptor.sourceGuidance).toBeTypeOf('string')

	const rootDescriptor = buildExternalPackageInvocationDescriptor({
		baseUrl: 'https://heykody.dev',
		ownerUsername: 'kentcdodds',
		kodyId: 'discord-gateway',
		exportName: '.',
	})

	expect(rootDescriptor).toMatchObject({
		url: 'https://heykody.dev/@kentcdodds/api/package-invocations/discord-gateway/__root__',
		path: '/@kentcdodds/api/package-invocations/discord-gateway/__root__',
		routeExportName: '__root__',
		normalizedExportName: '.',
		tokenSetupUrl:
			'https://heykody.dev/account/package-invocation-tokens/new?packageKodyIds=discord-gateway&exportNames=.',
	})
})
