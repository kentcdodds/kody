import { expect, test } from 'vitest'
import {
	mcpServerCapabilityId,
	mcpServerDomainId,
	mcpServerKodyName,
	mcpServerToolName,
} from './mcp-domain-id.ts'

test('MCP server ids keep clean names readable', () => {
	const ref = { name: 'linear' }

	expect(mcpServerDomainId(ref)).toBe('mcp:linear')
	expect(mcpServerKodyName(ref)).toBe('linear')
	expect(mcpServerToolName('create_issue')).toBe('create_issue')
	expect(mcpServerCapabilityId({ ref, toolName: 'create_issue' })).toBe(
		'mcp:linear:create_issue',
	)
})

test('MCP server ids disambiguate names that sanitize to the same slug', () => {
	const spacedRef = { name: 'my server' }
	const underscoredRef = { name: 'my_server' }
	const spacedTool = mcpServerToolName('create issue')
	const underscoredTool = mcpServerToolName('create_issue')

	expect(mcpServerKodyName(spacedRef)).toMatch(/^my_server_[0-9a-f]{8}$/)
	expect(mcpServerKodyName(underscoredRef)).toBe('my_server')
	expect(spacedTool).toMatch(/^create_issue_[0-9a-f]{8}$/)
	expect(underscoredTool).toBe('create_issue')
	expect(mcpServerKodyName(spacedRef)).not.toBe(
		mcpServerKodyName(underscoredRef),
	)
	expect(spacedTool).not.toBe(underscoredTool)
})

test('dashed MCP server names keep a stable tool-call accessor', () => {
	const ref = { name: 'my-server' }

	expect(mcpServerKodyName(ref)).toBe('my-server')
	expect(mcpServerDomainId(ref)).toBe('mcp:my-server')
	expect(mcpServerCapabilityId({ ref, toolName: 'search' })).toBe(
		'mcp:my-server:search',
	)
})
