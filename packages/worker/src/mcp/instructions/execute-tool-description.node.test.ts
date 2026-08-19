import { expect, test } from 'vitest'
import {
	executeToolDescription,
	executeToolDescriptionFragments,
} from './execute-tool-description.ts'

test('execute description keeps capability calls always-on and delegates the sandbox manual', () => {
	expect(executeToolDescriptionFragments).toHaveLength(4)
	expect(executeToolDescription.length).toBeLessThan(1_200)
	expect(executeToolDescription).toContain('kody.capability_id(input)')
	expect(executeToolDescription).toContain(
		'kody.mcp["server-name"].tool_name(input)',
	)
	expect(executeToolDescription).toContain(
		'kody.openapi["name"].operation_slug(input)',
	)
	expect(executeToolDescription).toContain('`coding_guide_get`')
	expect(executeToolDescription).toMatch(
		/secrets, package invocation, workflows, and idempotency/,
	)
	expect(executeToolDescription).not.toMatch(
		/packageStorage\(\)|secretHeaders\.basic|workflows\.create|packages\.invoke/,
	)
})
