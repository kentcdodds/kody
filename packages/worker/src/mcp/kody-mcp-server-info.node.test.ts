import { expect, test } from 'vitest'
import { buildKodyMcpServerInfo } from './kody-mcp-server-info.ts'

test('serverInfo keeps stable name/version and adds display metadata', () => {
	const info = buildKodyMcpServerInfo()
	expect(info).toMatchObject({
		name: 'kody-mcp',
		version: '1.0.0',
		title: 'Kody',
		description:
			"Your agents' cloud: search the catalog and run sandboxed modules with credentials, packages, jobs, and integrations.",
		websiteUrl: 'https://kody.codes',
	})
	expect(info.icons).toEqual([
		{
			src: 'https://kody.codes/android-chrome-192x192.png',
			mimeType: 'image/png',
			sizes: ['192x192'],
		},
		{
			src: 'https://kody.codes/android-chrome-512x512.png',
			mimeType: 'image/png',
			sizes: ['512x512'],
		},
	])
})
