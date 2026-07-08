import { expect, test } from 'vitest'
import {
	isValidMcpServerName,
	normalizeMcpServerName,
	validateMcpServerUrl,
} from './mcp-servers.ts'

test('MCP server names normalize to lowercase and validate the slug shape', () => {
	expect(normalizeMcpServerName('  Linear  ')).toBe('linear')
	expect(isValidMcpServerName('linear')).toBe(true)
	expect(isValidMcpServerName('my-server-2')).toBe(true)

	expect(isValidMcpServerName('')).toBe(false)
	expect(isValidMcpServerName('-leading-dash')).toBe(false)
	expect(isValidMcpServerName('has space')).toBe(false)
	expect(isValidMcpServerName('x'.repeat(65))).toBe(false)
})

test('MCP server URLs require https except for loopback hosts', () => {
	expect(validateMcpServerUrl('https://mcp.example.com/mcp')).toEqual({
		ok: true,
		url: 'https://mcp.example.com/mcp',
	})
	expect(validateMcpServerUrl('http://localhost:8787/mcp').ok).toBe(true)
	expect(validateMcpServerUrl('http://127.0.0.1:8787/mcp').ok).toBe(true)

	expect(validateMcpServerUrl('').ok).toBe(false)
	expect(validateMcpServerUrl('not a url').ok).toBe(false)
	expect(validateMcpServerUrl('http://example.com/mcp').ok).toBe(false)
})
