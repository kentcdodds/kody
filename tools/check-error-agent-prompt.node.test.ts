import { expect, test } from 'vitest'
import { checkErrorAgentPromptSurfaces } from './check-error-agent-prompt.ts'
import {
	errorAgentPromptAdoptFiles,
	errorAgentPromptMarker,
} from './error-agent-prompt-surfaces.ts'

test('error-agent-prompt inventory lists unique adopt paths', () => {
	expect(new Set(errorAgentPromptAdoptFiles).size).toBe(
		errorAgentPromptAdoptFiles.length,
	)
	expect(errorAgentPromptMarker).toBe('data-error-agent-prompt')
})

test('error-agent-prompt guard passes on the current repo inventory', () => {
	// This fails until adopt surfaces stamp the marker — that is intentional
	// while the PR wires them. After adoption it must stay green.
	const issues = checkErrorAgentPromptSurfaces()
	expect(issues).toEqual([])
})
