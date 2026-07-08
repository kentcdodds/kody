import { expect, test } from 'vitest'
import {
	mcpServerCapabilityId,
	mcpServerDomainId,
	mcpServerKodyName,
	mcpServerToolName,
} from './mcp-domain-id.ts'

test('MCP server ids keep clean names readable', () => {
	const linearRef = { name: 'linear' }
	const dashedRef = { name: 'my-server' }

	expect(mcpServerDomainId(linearRef)).toBe('mcp:linear')
	expect(mcpServerKodyName(linearRef)).toBe('linear')
	expect(mcpServerToolName('create_issue')).toBe('create_issue')
	expect(
		mcpServerCapabilityId({ ref: linearRef, toolName: 'create_issue' }),
	).toBe('mcp:linear:create_issue')

	expect(mcpServerKodyName(dashedRef)).toBe('my-server')
	expect(mcpServerDomainId(dashedRef)).toBe('mcp:my-server')
	expect(mcpServerCapabilityId({ ref: dashedRef, toolName: 'search' })).toBe(
		'mcp:my-server:search',
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
