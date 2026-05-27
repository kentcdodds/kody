import { expect, test } from 'vitest'
import {
	RepoCommandParseError,
	parseRepoGitCommands,
} from './repo-session-commands.ts'

test('parseRepoGitCommands handles heredocs, delimiters, errors, and quoted operands', () => {
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

	expect(() => parseRepoGitCommands('git status\nnpm test')).toThrow(
		new RepoCommandParseError({
			line: 2,
			command: 'npm test',
			reason: 'commands must start with "git".',
		}),
	)

	const indentedDelimiterCommands = [
		"git apply <<'PATCH'",
		'--- a/src/index.ts',
		'+++ b/src/index.ts',
		'@@ -1,2 +1,2 @@',
		' PATCH',
		'-old',
		'+new',
		'PATCH',
	].join('\n')
	const parsedIndented = parseRepoGitCommands(indentedDelimiterCommands)
	expect(parsedIndented).toHaveLength(1)
	expect(parsedIndented[0]).toMatchObject({ kind: 'apply' })
	expect(
		parsedIndented[0]?.kind === 'apply' ? parsedIndented[0].patch : '',
	).toContain(' PATCH')

	expect(() => parseRepoGitCommands('git apply patch.diff')).toThrow(
		/git apply requires heredoc form/,
	)
	expect(() => parseRepoGitCommands('git checkout -b ""')).toThrow(
		/branch name cannot be empty/,
	)
	expect(() => parseRepoGitCommands("git branch -d ''")).toThrow(
		/branch name cannot be empty/,
	)
})
