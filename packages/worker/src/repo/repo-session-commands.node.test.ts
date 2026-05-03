import { expect, test } from 'vitest'
import {
	RepoCommandParseError,
	parseRepoGitCommands,
} from './repo-session-commands.ts'

test('parseRepoGitCommands parses a git apply heredoc and follow-up commands', () => {
	const commands = [
		"git apply <<'PATCH'",
		'--- a/src/index.ts',
		'+++ b/src/index.ts',
		'@@ -1 +1 @@',
		'-export const ok = false',
		'+export const ok = true',
		'PATCH',
		'git add .',
		'git commit -m "update package"',
	].join('\n')

	expect(parseRepoGitCommands(commands)).toEqual([
		{
			kind: 'apply',
			line: 1,
			raw: "git apply <<'PATCH'",
			patch: [
				'--- a/src/index.ts',
				'+++ b/src/index.ts',
				'@@ -1 +1 @@',
				'-export const ok = false',
				'+export const ok = true',
			].join('\n'),
		},
		{ kind: 'add', line: 8, raw: 'git add .', filepath: '.' },
		{
			kind: 'commit',
			line: 9,
			raw: 'git commit -m "update package"',
			message: 'update package',
		},
	])
})

test('parseRepoGitCommands reports line-specific unsupported command errors', () => {
	expect(() => parseRepoGitCommands('git status\nnpm test')).toThrow(
		new RepoCommandParseError({
			line: 2,
			command: 'npm test',
			reason: 'commands must start with "git".',
		}),
	)
})

test('parseRepoGitCommands explains malformed git apply usage', () => {
	expect(() => parseRepoGitCommands('git apply patch.diff')).toThrow(
		/git apply requires heredoc form/,
	)
})
