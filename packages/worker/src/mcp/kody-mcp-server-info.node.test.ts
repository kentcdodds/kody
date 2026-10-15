import { expect, test } from 'vitest'
import {
	buildKodyMcpServerInfo,
	kodyMcpServerDescription,
	kodyMcpServerName,
	kodyMcpServerTitle,
	kodyMcpServerVersion,
	kodyMcpServerWebsiteUrl,
} from './kody-mcp-server-info.ts'

test('serverInfo keeps stable name/version and adds display metadata', () => {
	const info = buildKodyMcpServerInfo()
	expect(info).toMatchObject({
		name: kodyMcpServerName,
		version: kodyMcpServerVersion,
		title: kodyMcpServerTitle,
		description: kodyMcpServerDescription,
		websiteUrl: kodyMcpServerWebsiteUrl,
	})
	expect(info.description).toContain('search')
	expect(info.description).toContain('sandboxed')
	expect(info.websiteUrl).toBe('https://kody.codes')
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

test('serverInfo icons always use production absolute URLs', () => {
	const info = buildKodyMcpServerInfo()
	expect(
		info.icons?.every((icon) => icon.src.startsWith('https://kody.codes/')),
	).toBe(true)
	expect(info.icons?.some((icon) => icon.src.includes('localhost'))).toBe(false)
})
