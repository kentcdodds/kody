import { applyPatch, parsePatch } from 'diff'
import { expect, test } from 'vitest'
import {
	parseGitDiffHeaders,
	resolveUnifiedDiffFileNames,
	splitUnifiedDiffSections,
	stripUnifiedDiffPath,
} from './unified-diff-paths.ts'

test('parseGitDiffHeaders reads unquoted, quoted, rename, and multi-file paths', () => {
	expect(
		parseGitDiffHeaders(`diff --git a/foo.ts b/foo.ts
index 111..222 100644
@@ -1 +1 @@
-a
+b
`),
	).toEqual([{ oldFileName: 'a/foo.ts', newFileName: 'b/foo.ts' }])

	expect(
		parseGitDiffHeaders(
			`diff --git "a/foo bar.ts" "b/foo bar.ts"\n@@ -1 +1 @@\n-a\n+b\n`,
		),
	).toEqual([{ oldFileName: 'a/foo bar.ts', newFileName: 'b/foo bar.ts' }])

	expect(
		parseGitDiffHeaders(
			`diff --git "a/foo\\"bar.ts" "b/foo\\"bar.ts"\n@@ -1 +1 @@\n-a\n+b\n`,
		),
	).toEqual([{ oldFileName: 'a/foo"bar.ts', newFileName: 'b/foo"bar.ts' }])

	expect(
		parseGitDiffHeaders(`diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
`),
	).toEqual([{ oldFileName: 'a/old.ts', newFileName: 'b/new.ts' }])

	expect(
		parseGitDiffHeaders(`diff --git a/a.ts b/a.ts
@@ -1 +1 @@
-a
+A
diff --git a/b.ts b/b.ts
@@ -1 +1 @@
-b
+B
`),
	).toEqual([
		{ oldFileName: 'a/a.ts', newFileName: 'b/a.ts' },
		{ oldFileName: 'a/b.ts', newFileName: 'b/b.ts' },
	])
})

test('resolveUnifiedDiffFileNames prefers ---/+++ names and fills gaps from git headers', () => {
	expect(
		resolveUnifiedDiffFileNames(
			{ oldFileName: 'a/from-dashes.ts', newFileName: 'b/from-dashes.ts' },
			{ oldFileName: 'a/from-git.ts', newFileName: 'b/from-git.ts' },
		),
	).toEqual({
		oldFileName: 'a/from-dashes.ts',
		newFileName: 'b/from-dashes.ts',
	})

	expect(
		resolveUnifiedDiffFileNames(
			{},
			{ oldFileName: 'a/foo.ts', newFileName: 'b/foo.ts' },
		),
	).toEqual({ oldFileName: 'a/foo.ts', newFileName: 'b/foo.ts' })

	expect(
		resolveUnifiedDiffFileNames(
			{ oldFileName: '', newFileName: '' },
			{ oldFileName: 'a/foo.ts', newFileName: 'b/foo.ts' },
		),
	).toEqual({ oldFileName: 'a/foo.ts', newFileName: 'b/foo.ts' })

	expect(
		resolveUnifiedDiffFileNames(
			{ oldFileName: '/dev/null', newFileName: '' },
			{ oldFileName: 'a/foo.ts', newFileName: 'b/foo.ts' },
		),
	).toEqual({ oldFileName: '/dev/null', newFileName: 'b/foo.ts' })

	expect(
		resolveUnifiedDiffFileNames(
			{ oldFileName: 'a/foo.ts', newFileName: '/dev/null' },
			{ oldFileName: 'a/foo.ts', newFileName: 'b/foo.ts' },
		),
	).toEqual({ oldFileName: 'a/foo.ts', newFileName: '/dev/null' })

	expect(
		resolveUnifiedDiffFileNames(
			{},
			{ oldFileName: 'a/foo.ts', newFileName: 'b/foo.ts', isNew: true },
		),
	).toEqual({ oldFileName: '/dev/null', newFileName: 'b/foo.ts' })

	expect(
		resolveUnifiedDiffFileNames(
			{},
			{ oldFileName: 'a/foo.ts', newFileName: 'b/foo.ts', isDelete: true },
		),
	).toEqual({ oldFileName: 'a/foo.ts', newFileName: '/dev/null' })

	expect(
		resolveUnifiedDiffFileNames({ oldFileName: '', newFileName: '' }),
	).toEqual({
		oldFileName: undefined,
		newFileName: undefined,
	})
})

test('stripUnifiedDiffPath removes a/b prefixes and treats /dev/null as no path', () => {
	expect(stripUnifiedDiffPath('a/src/foo.ts')).toBe('src/foo.ts')
	expect(stripUnifiedDiffPath('b/src/foo.ts')).toBe('src/foo.ts')
	expect(stripUnifiedDiffPath('/dev/null')).toBeNull()
	expect(stripUnifiedDiffPath('')).toBeNull()
	expect(stripUnifiedDiffPath(undefined)).toBeNull()
	expect(stripUnifiedDiffPath('a/')).toBeNull()
})

test('split sections resolve git-header-only patches so jsdiff can apply them', () => {
	const gitHeaderOnly = [
		'diff --git a/src/keep.ts b/src/keep.ts',
		'index 111..222 100644',
		'@@ -1 +1 @@',
		'-export const keep = false',
		'+export const keep = true',
	].join('\n')
	const [gitSection] = splitUnifiedDiffSections(gitHeaderOnly)
	const [gitPatch] = parsePatch(gitSection!.text)
	const gitNames = resolveUnifiedDiffFileNames(gitPatch!, gitSection!.header)
	expect(stripUnifiedDiffPath(gitNames.newFileName)).toBe('src/keep.ts')
	gitPatch!.oldFileName = gitNames.oldFileName
	gitPatch!.newFileName = gitNames.newFileName
	expect(applyPatch('export const keep = false\n', gitPatch!)).toBe(
		'export const keep = true\n',
	)

	const blankDashes = [
		'diff --git a/src/keep.ts b/src/keep.ts',
		'--- ',
		'+++ ',
		'@@ -1 +1 @@',
		'-export const keep = true',
		'+export const keep = false',
	].join('\n')
	const [blankSection] = splitUnifiedDiffSections(blankDashes)
	const [blankPatch] = parsePatch(blankSection!.text)
	expect(blankPatch?.oldFileName).toBe('')
	expect(blankPatch?.newFileName).toBe('')
	const blankNames = resolveUnifiedDiffFileNames(
		blankPatch!,
		blankSection!.header,
	)
	expect(stripUnifiedDiffPath(blankNames.newFileName)).toBe('src/keep.ts')
	blankPatch!.oldFileName = blankNames.oldFileName
	blankPatch!.newFileName = blankNames.newFileName
	expect(applyPatch('export const keep = true\n', blankPatch!)).toBe(
		'export const keep = false\n',
	)

	const dashes = [
		'--- a/src/keep.ts',
		'+++ b/src/keep.ts',
		'@@ -1 +1 @@',
		'-export const keep = false',
		'+export const keep = true',
		'--- /dev/null',
		'+++ b/src/new.ts',
		'@@ -0,0 +1 @@',
		'+export const neu = true',
		'--- a/src/other.ts',
		'+++ /dev/null',
		'@@ -1 +0,0 @@',
		'-export const other = 1',
	].join('\n')
	const dashSections = splitUnifiedDiffSections(dashes)
	expect(dashSections).toHaveLength(3)
	const dashResolved = dashSections.flatMap((section) =>
		parsePatch(section.text).map((patch) => {
			const names = resolveUnifiedDiffFileNames(patch, section.header)
			return {
				targetPath:
					stripUnifiedDiffPath(names.newFileName) ??
					stripUnifiedDiffPath(names.oldFileName),
				isDelete: names.newFileName === '/dev/null',
			}
		}),
	)
	expect(dashResolved).toEqual([
		{ targetPath: 'src/keep.ts', isDelete: false },
		{ targetPath: 'src/new.ts', isDelete: false },
		{ targetPath: 'src/other.ts', isDelete: true },
	])

	const multi = [
		'diff --git a/src/a.ts b/src/a.ts',
		'index 1..2 100644',
		'@@ -1 +1 @@',
		'-a',
		'+A',
		'diff --git a/src/b.ts b/src/b.ts',
		'index 1..2 100644',
		'@@ -1 +1 @@',
		'-b',
		'+B',
	].join('\n')
	const multiSections = splitUnifiedDiffSections(multi)
	expect(multiSections.map((section) => section.header?.oldFileName)).toEqual([
		'a/src/a.ts',
		'a/src/b.ts',
	])
	const multiApplied = multiSections.map((section, index) => {
		const [patch] = parsePatch(section.text)
		const names = resolveUnifiedDiffFileNames(patch!, section.header)
		patch!.oldFileName = names.oldFileName
		patch!.newFileName = names.newFileName
		return applyPatch(index === 0 ? 'a\n' : 'b\n', patch!)
	})
	expect(multiApplied).toEqual(['A\n', 'B\n'])

	const hunkOnly = ['@@ -1 +1 @@', '-a', '+b'].join('\n')
	expect(splitUnifiedDiffSections(hunkOnly)).toEqual([])

	const bothNull = [
		'--- /dev/null',
		'+++ /dev/null',
		'@@ -0,0 +1 @@',
		'+x',
	].join('\n')
	const [bothNullSection] = splitUnifiedDiffSections(bothNull)
	const [bothNullPatch] = parsePatch(bothNullSection!.text)
	const bothNullNames = resolveUnifiedDiffFileNames(
		bothNullPatch!,
		bothNullSection!.header,
	)
	expect(stripUnifiedDiffPath(bothNullNames.oldFileName)).toBeNull()
	expect(stripUnifiedDiffPath(bothNullNames.newFileName)).toBeNull()
})
