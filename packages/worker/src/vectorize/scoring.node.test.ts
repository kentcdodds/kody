import { expect, test } from 'vitest'
import { lexicalScore, tokenizeSearchText } from './scoring.ts'

test('tokenizeSearchText splits camelCase identifiers the same way underscores already split', () => {
	expect([...tokenizeSearchText('adminUserList')].sort()).toEqual([
		'admin',
		'list',
		'user',
	])
	expect([...tokenizeSearchText('admin_user_list')].sort()).toEqual([
		'admin',
		'list',
		'user',
	])
	expect([...tokenizeSearchText('mcpServers')].sort()).toEqual([
		'mcp',
		'servers',
	])
})

test('lexicalScore matches space-separated queries against camelCase capability names', () => {
	expect(lexicalScore('admin users roles audit', 'adminUserList\nadmin')).toBe(
		lexicalScore('admin users roles audit', 'admin_user_list\nadmin'),
	)
	expect(
		lexicalScore('admin user', 'adminUserList\nadmin users roles'),
	).toBeGreaterThan(0)
})
