import { expect, test } from 'vitest'
import {
	isValidMcpServerName,
	mcpServerAuthorizationHeaders,
	mcpServerBearerTokenMaxLength,
	normalizeMcpServerBearerToken,
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

test('MCP server bearer tokens normalize to Authorization header values', () => {
	expect(normalizeMcpServerBearerToken(undefined)).toEqual({ ok: true })
	expect(normalizeMcpServerBearerToken('')).toEqual({ ok: true })
	expect(normalizeMcpServerBearerToken('   ')).toEqual({ ok: true })
	expect(normalizeMcpServerBearerToken('secret-token')).toEqual({
		ok: true,
		authorization: 'Bearer secret-token',
	})
	expect(normalizeMcpServerBearerToken('Bearer already')).toEqual({
		ok: true,
		authorization: 'Bearer already',
	})
	expect(normalizeMcpServerBearerToken('token abc.def')).toEqual({
		ok: true,
		authorization: 'token abc.def',
	})
	expect(
		normalizeMcpServerBearerToken('Authorization: Bearer pasted-header'),
	).toEqual({
		ok: true,
		authorization: 'Bearer pasted-header',
	})
	expect(normalizeMcpServerBearerToken('authorization:token xyz')).toEqual({
		ok: true,
		authorization: 'token xyz',
	})
	expect(normalizeMcpServerBearerToken('Authorization:').ok).toBe(false)
	expect(
		normalizeMcpServerBearerToken('x'.repeat(mcpServerBearerTokenMaxLength + 1))
			.ok,
	).toBe(false)
	expect(mcpServerAuthorizationHeaders(undefined)).toBeUndefined()
	expect(mcpServerAuthorizationHeaders('Bearer secret')).toEqual({
		Authorization: 'Bearer secret',
	})
})
