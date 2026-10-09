import { expect, test } from 'vitest'
import {
	buildOrgBoundMcpUrl,
	readOrgSlugFromUrl,
	stripOrgFromResourceUri,
} from './url.ts'

test('readOrgSlugFromUrl normalizes lowercase and ignores blanks', () => {
	expect(readOrgSlugFromUrl('https://kody.codes/mcp?org=Acme')).toBe('acme')
	expect(
		readOrgSlugFromUrl(new URL('https://kody.codes/oauth/authorize?org=ada')),
	).toBe('ada')
	expect(readOrgSlugFromUrl('https://kody.codes/mcp')).toBeNull()
	expect(readOrgSlugFromUrl('https://kody.codes/mcp?org=')).toBeNull()
	expect(readOrgSlugFromUrl('not-a-url')).toBeNull()
})

test('stripOrgFromResourceUri keeps profile and drops only org', () => {
	expect(
		stripOrgFromResourceUri('https://kody.codes/mcp?org=acme&profile=CI+Bot'),
	).toEqual({
		canonicalResource: 'https://kody.codes/mcp?profile=CI+Bot',
		orgSlug: 'acme',
	})
	expect(stripOrgFromResourceUri('https://kody.codes/mcp')).toEqual({
		canonicalResource: 'https://kody.codes/mcp',
		orgSlug: null,
	})
})

test('buildOrgBoundMcpUrl sets lowercase org', () => {
	expect(
		buildOrgBoundMcpUrl({
			mcpServerUrl: 'https://kody.codes/mcp',
			orgSlug: 'Acme',
		}),
	).toBe('https://kody.codes/mcp?org=acme')
})
