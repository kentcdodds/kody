import { expect, test } from 'vitest'
import { kodyappsDevToKodyRunCodemod } from './0004-kodyapps-dev-to-kody-run.ts'

test('0004 rewrites apex and per-user subdomain origins and preserves boundaries', () => {
	const files = {
		'index.ts': [
			"const apex = 'https://kodyapps.dev'",
			"const hosted = 'https://alice.kodyapps.dev/packages/demo/report?x=1'",
			"const path = 'https://kodyapps.dev/@alice/packages/demo'",
			'',
		].join('\n'),
		'README.md': 'Docs: visit https://alice.kodyapps.dev.\n',
	}

	const result = kodyappsDevToKodyRunCodemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['index.ts', 'README.md'])
	expect(result.files['index.ts']).toBe(
		[
			"const apex = 'https://kody.run'",
			"const hosted = 'https://alice.kody.run/packages/demo/report?x=1'",
			"const path = 'https://kody.run/@alice/packages/demo'",
			'',
		].join('\n'),
	)
	expect(result.files['README.md']).toBe(
		'Docs: visit https://alice.kody.run.\n',
	)
	expect(result.needsManual).toEqual([])

	const again = kodyappsDevToKodyRunCodemod.transform(result.files)
	expect(again.changed).toBe(false)
	expect(again.changedPaths).toEqual([])
})

test('0004 never rewrites kody.codes, heykody hosts, emails, or lookalike hosts', () => {
	const boundaryFiles = {
		'config.ts': [
			"const site = 'https://kody.codes'",
			"const mcp = 'https://kody.codes/mcp'",
			"const heykody = 'https://heykody.app/@user/packages/demo'",
			"const status = 'https://status.heykody.dev'",
			"const inbox = 'you@inbox.kody.codes'",
			"const evil = 'https://kodyapps.dev.evil.example'",
			"const nested = 'https://a.b.kodyapps.dev/packages/demo'",
			"const bare = 'served from kodyapps.dev for now'",
			"const legacyVar = 'PACKAGE_APP_LEGACY_HOSTS=kodyapps.dev'",
			'',
		].join('\n'),
	}
	const boundaryResult = kodyappsDevToKodyRunCodemod.transform(boundaryFiles)
	expect(boundaryResult.changed).toBe(false)
	expect(boundaryResult.files['config.ts']).toBe(boundaryFiles['config.ts'])
	expect(boundaryResult.needsManual).toEqual([
		{
			path: 'config.ts',
			message: expect.stringContaining('manually'),
		},
	])

	const lookalikeFiles = {
		'phish.ts': "const evil = 'https://kodyapps.dev.evil.example/app'\n",
	}
	const lookalikeResult = kodyappsDevToKodyRunCodemod.transform(lookalikeFiles)
	expect(lookalikeResult.changed).toBe(false)
	expect(lookalikeResult.files['phish.ts']).toBe(lookalikeFiles['phish.ts'])
	expect(lookalikeResult.needsManual).toEqual([
		{ path: 'phish.ts', message: expect.stringContaining('manually') },
	])
})

test('0004 detect reports rewritable origins and skips binary-ish paths', () => {
	const files = {
		'index.ts': "export const url = 'https://bob.kodyapps.dev/packages/x'\n",
		'logo.png': 'https://kodyapps.dev pretend-binary',
	}
	const findings = kodyappsDevToKodyRunCodemod.detect(files)
	expect(findings).toEqual([
		{
			path: 'index.ts',
			message: expect.stringContaining('rewrite to https://kody.run'),
		},
	])
	const result = kodyappsDevToKodyRunCodemod.transform(files)
	expect(result.changedPaths).toEqual(['index.ts'])
	expect(result.files['logo.png']).toBe(files['logo.png'])
})
