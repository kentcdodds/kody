import { expect, test } from 'vitest'
import {
	buildSecretPackageApprovalUrl,
	buildSecretPackageBulkApprovalUrl,
	buildSecretPackageBulkApprovalUrlIfNeeded,
	buildSecretUsageUrl,
	normalizeBulkPackageSecretApprovalNames,
} from './package-approval-url.ts'

test('buildSecretUsageUrl keeps Remix %2E encoding for dotted secret names', () => {
	expect(
		buildSecretUsageUrl({
			baseUrl: 'https://kody.codes',
			orgSlug: 'ada',
			name: 'openai-api-key',
		}),
	).toBe('https://kody.codes/@ada/-/secrets/user/openai-api-key')
	expect(
		buildSecretUsageUrl({
			baseUrl: 'https://kody.codes',
			orgSlug: 'ada',
			name: 'google.api.key',
		}),
	).toBe('https://kody.codes/@ada/-/secrets/user/google%2Eapi%2Ekey')
})

test('buildSecretPackageApprovalUrl keeps the single-secret detail path', () => {
	expect(
		buildSecretPackageApprovalUrl({
			baseUrl: 'https://example.com',
			orgSlug: 'ada',
			name: 'discordBotToken',
			scope: 'user',
			packageId: 'pkg-1',
			kodyId: 'release',
			storageContext: null,
		}),
	).toBe(
		'https://example.com/@ada/-/secrets/user/discordBotToken?package_id=pkg-1&package=release',
	)
})

test('bulk package approval URL lists unique secret names on the approve route', () => {
	expect(
		normalizeBulkPackageSecretApprovalNames([
			' discordBotToken ',
			'xAccessToken',
			'discordBotToken',
			'bad name',
			'',
		]),
	).toEqual(['discordBotToken', 'xAccessToken'])

	expect(
		buildSecretPackageBulkApprovalUrl({
			baseUrl: 'https://example.com',
			orgSlug: 'ada',
			packageId: 'pkg-1',
			kodyId: 'release',
			names: ['discordBotToken', 'xAccessToken', 'githubAccessToken'],
		}),
	).toBe(
		'https://example.com/@ada/-/secrets/approve?package_id=pkg-1&package=release&names=discordBotToken%2CxAccessToken%2CgithubAccessToken',
	)

	expect(
		buildSecretPackageBulkApprovalUrlIfNeeded({
			baseUrl: 'https://example.com',
			orgSlug: 'ada',
			packageId: 'pkg-1',
			kodyId: 'release',
			names: ['onlyOne'],
		}),
	).toBeNull()
})
