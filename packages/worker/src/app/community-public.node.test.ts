import { expect, test } from 'vitest'
import {
	buildExistingInstallPrompt,
	buildInstallSuccessPrompt,
} from './community-public.ts'

test('install prompts send agents to repoReadFile for README and AGENTS', () => {
	const success = buildInstallSuccessPrompt({
		targetName: '@me/package-app-kit',
	})
	const existing = buildExistingInstallPrompt({
		targetName: '@me/package-app-kit',
	})

	for (const prompt of [success, existing]) {
		expect(prompt).toContain('does not return files')
		expect(prompt).toContain(
			'repoOpenSession({ target: { kind: "package", kody_id: "@me/package-app-kit" } })',
		)
		expect(prompt).toContain('repoReadFile README.md and AGENTS.md')
	}
})
