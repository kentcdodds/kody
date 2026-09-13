import { expect, test } from 'vitest'
import { inlineWorkflowNameSubtitle } from '#universal/workflow-display.ts'

test('inline workflow name subtitle appears only for the inline-code fallback', () => {
	expect(inlineWorkflowNameSubtitle('inline-code', 'sync-account-123')).toBe(
		'sync-account-123',
	)
	expect(inlineWorkflowNameSubtitle('  inline-code  ', '  key  ')).toBe('key')
	expect(inlineWorkflowNameSubtitle('./workflow-run-event', 'key')).toBeNull()
	expect(inlineWorkflowNameSubtitle('Nightly digest', 'key')).toBeNull()
	expect(inlineWorkflowNameSubtitle('Workflow', 'key')).toBeNull()
	expect(inlineWorkflowNameSubtitle('inline-code', '  ')).toBeNull()
	expect(inlineWorkflowNameSubtitle('inline-code', null)).toBeNull()
	expect(inlineWorkflowNameSubtitle('inline-code', undefined)).toBeNull()
})
