import { expect, test } from 'vitest'
import { remoteConnectorToMcpServerCodemod } from './0005-remote-connector-to-mcp-server.ts'

test('0005 rewrites kody.remote accessors and capability ids', () => {
	const files = {
		'index.ts': [
			'await kody.remote["home"].turn_on({ device: "lamp" })',
			"await kody.remote['home'].turn_off({})",
			'await kody.remote.home.ping({})',
			'const name = "home"',
			'await kody.remote[name].status({})',
			'const id = "remote:home:turn_on"',
			'',
		].join('\n'),
		'README.md': 'Call `kody.remote["home"].status({})` or `remote:home:status`.\n',
	}

	const result = remoteConnectorToMcpServerCodemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['index.ts', 'README.md'])
	expect(result.files['index.ts']).toBe(
		[
			'await kody.mcp["home"].turn_on({ device: "lamp" })',
			"await kody.mcp['home'].turn_off({})",
			'await kody.mcp.home.ping({})',
			'const name = "home"',
			'await kody.mcp[name].status({})',
			'const id = "mcp:home:turn_on"',
			'',
		].join('\n'),
	)
	expect(result.files['README.md']).toBe(
		'Call `kody.mcp["home"].status({})` or `mcp:home:status`.\n',
	)
	expect(result.needsManual).toEqual([])

	const again = remoteConnectorToMcpServerCodemod.transform(result.files)
	expect(again.changed).toBe(false)
	expect(again.changedPaths).toEqual([])
})

test('0005 flags ambiguous remote mentions without rewriting them', () => {
	const files = {
		'config.ts': [
			'const remote = getClient()',
			'await remote.call("ping")',
			'const note = "remote:something"',
			'',
		].join('\n'),
	}
	const result = remoteConnectorToMcpServerCodemod.transform(files)
	expect(result.changed).toBe(false)
	expect(result.files['config.ts']).toBe(files['config.ts'])
	expect(result.needsManual).toEqual([
		{
			path: 'config.ts',
			message: expect.stringContaining('manually'),
		},
	])
})

test('0005 detect reports rewritable accessors and skips binary-ish paths', () => {
	const files = {
		'index.ts': 'export const call = kody.remote["home"].ping\n',
		'logo.png': 'kody.remote pretend-binary',
	}
	const findings = remoteConnectorToMcpServerCodemod.detect(files)
	expect(findings).toEqual([
		{
			path: 'index.ts',
			message: expect.stringContaining('kody.mcp'),
		},
	])
	const result = remoteConnectorToMcpServerCodemod.transform(files)
	expect(result.changedPaths).toEqual(['index.ts'])
	expect(result.files['logo.png']).toBe(files['logo.png'])
})
