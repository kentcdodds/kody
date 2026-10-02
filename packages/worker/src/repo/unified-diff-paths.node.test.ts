import { expect, test } from 'vitest'
import {
	parseGitDiffHeaders,
	resolveUnifiedDiffFileNames,
	stripUnifiedDiffPath,
} from './unified-diff-paths.ts'

test('parseGitDiffHeaders reads unquoted, quoted, rename, and /dev/null paths', () => {
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
