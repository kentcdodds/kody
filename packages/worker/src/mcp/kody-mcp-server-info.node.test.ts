import { expect, test } from 'vitest'
import {
	buildKodyMcpServerInfo,
	kodyMcpServerDescription,
	kodyMcpServerName,
	kodyMcpServerVersion,
	kodyMcpServerWebsiteUrl,
} from './kody-mcp-server-info.ts'

test('serverInfo keeps stable name/version and adds display metadata', () => {
	const info = buildKodyMcpServerInfo('https://preview.example')
	expect(info).toMatchObject({
		name: kodyMcpServerName,
		version: kodyMcpServerVersion,
		title: 'Kody',
		description: kodyMcpServerDescription,
		websiteUrl: kodyMcpServerWebsiteUrl,
	})
	expect(info.description).toContain('search')
	expect(info.description).toContain('sandboxed')
	expect(info.websiteUrl).toBe('https://kody.codes')
	expect(info.icons).toEqual([
		{
			src: 'https://preview.example/android-chrome-192x192.png',
			mimeType: 'image/png',
			sizes: ['192x192'],
		},
		{
			src: 'https://preview.example/android-chrome-512x512.png',
			mimeType: 'image/png',
			sizes: ['512x512'],
		},
	])
})

test('serverInfo omits icons when base URL is unknown', () => {
	const info = buildKodyMcpServerInfo(null)
	expect(info.icons).toBeUndefined()
	expect(info.name).toBe(kodyMcpServerName)
	expect(info.title).toBe('Kody')
})
