import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	checkMermaidMarkdown,
	checkMermaidSyntax,
	extractFencedMermaidBlocks,
	listMermaidSourcePaths,
	parseMermaidCheckArgs,
	parseMermaidDiagram,
} from './check-mermaid-syntax.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const githubPlusNoteDiagram = [
	'sequenceDiagram',
	'  actor Caller',
	'  participant vite as Vite + Pitlane',
	'  participant appUi as app-ui',
	'  participant originWorker as origin worker',
	'  Caller->>vite: vite serve or vite build',
	'  vite->>appUi: transform clientEntry(import.meta.url) and ?assets=',
	'  Note over vite: serve writes origin local-dev vars; jobs+highlight stay in test',
	'  vite->>originWorker: SSR entry from Wrangler main',
	'  Caller->>originWorker: GET HTML route',
	'  originWorker->>appUi: resolveClientEntry to hashed /assets/entry-*.js',
	'  appUi-->>Caller: data-rmx-* document plus /assets/* modules',
].join('\n')

const githubPlusNoteFixed = githubPlusNoteDiagram.replace(
	'Note over vite: serve writes origin local-dev vars; jobs+highlight stay in test',
	'Note over vite: serve writes origin local-dev vars, jobs and highlight stay in test',
)

const visualRecapSequence = [
	'sequenceDiagram',
	'\tactor User',
	'\tparticipant appUi as app-ui',
	'\tparticipant appSessions as app-sessions',
	'\tparticipant rbac as rbac',
	'\tparticipant d1AppDb as d1-app-db',
	'\tUser->>appUi: click provider button',
	'\tappUi->>appSessions: POST /auth/:provider',
	'\tappSessions->>rbac: 2FA gate on sign-in',
	'\tappSessions->>d1AppDb: insert oauth_connections',
	'\tNote over d1AppDb: new table is an export + deletion target',
].join('\n')

const visualRecapFlowchart = [
	'flowchart LR',
	'\tappUi["app-ui<br/>Browser app"]:::touched',
	'\tappSessions["app-sessions<br/>Browser sessions"]:::extended',
	'\td1AppDb["d1-app-db<br/>D1 app database"]:::extended',
	'\taccountExport["account-export<br/>Account data export"]:::extended',
	'\trbac["rbac<br/>Role-based access control"]:::untouched',
	'\tappUi -->|"POST /auth/:provider buttons"| appSessions',
	'\tappSessions -->|"oauth_connections table"| d1AppDb',
	'\tappSessions -->|"2FA gate on sign-in"| rbac',
	'\taccountExport -->|"export + deletion targets"| d1AppDb',
	'\tclassDef touched fill:#1a7f37,color:#fff',
	'\tclassDef extended fill:#9a6700,color:#fff',
	'\tclassDef added fill:#cf222e,color:#fff',
	'\tclassDef untouched fill:#57606a,color:#fff',
].join('\n')

test('extractFencedMermaidBlocks finds mermaid inside wrapping example fences', () => {
	const content = [
		'Intro.',
		'',
		'````markdown',
		'```mermaid',
		'sequenceDiagram',
		'\tA->>B: hop',
		'```',
		'````',
		'',
		'~~~mermaid',
		'flowchart LR',
		'\tA --> B',
		'~~~',
	].join('\n')

	expect(extractFencedMermaidBlocks({ source: 'example.md', content })).toEqual(
		[
			{
				source: 'example.md',
				startLine: 4,
				closed: true,
				code: 'sequenceDiagram\n\tA->>B: hop',
			},
			{
				source: 'example.md',
				startLine: 10,
				closed: true,
				code: 'flowchart LR\n\tA --> B',
			},
		],
	)
})

test('the GitHub jobs+highlight sequence note fails to parse', async () => {
	const parsed = await parseMermaidDiagram(githubPlusNoteDiagram)
	expect(parsed.ok).toBe(false)
	if (parsed.ok) {
		return
	}
	expect(parsed.mermaidLine).toBe(8)
	expect(parsed.message).toContain("got '+'")
})

test('rephrasing the semicolon note makes the GitHub diagram parse', async () => {
	await expect(parseMermaidDiagram(githubPlusNoteFixed)).resolves.toEqual({
		ok: true,
		diagramType: 'sequence',
	})
})

test('visual-recap skill example diagrams parse', async () => {
	await expect(parseMermaidDiagram(visualRecapSequence)).resolves.toEqual({
		ok: true,
		diagramType: 'sequence',
	})
	await expect(parseMermaidDiagram(visualRecapFlowchart)).resolves.toEqual({
		ok: true,
		diagramType: 'flowchart-v2',
	})
})

test('checkMermaidMarkdown reports fence-relative GitHub failures', async () => {
	const recap = [
		'<!-- system-recap:start -->',
		'',
		'### Change flow',
		'',
		'```mermaid',
		githubPlusNoteDiagram,
		'```',
		'',
		'<!-- system-recap:end -->',
	].join('\n')

	const issues = await checkMermaidMarkdown({
		source: 'recap.md',
		content: recap,
	})
	expect(issues).toEqual([
		expect.objectContaining({
			file: 'recap.md',
			line: 13,
			message: expect.stringContaining("got '+'"),
		}),
	])
})

test('checkMermaidMarkdown accepts recap markdown with valid mermaid', async () => {
	const recap = [
		'```mermaid',
		githubPlusNoteFixed,
		'```',
		'',
		'```mermaid',
		visualRecapFlowchart,
		'```',
	].join('\n')

	await expect(
		checkMermaidMarkdown({ source: 'recap.md', content: recap }),
	).resolves.toEqual([])
})

test('raw mermaid on stdin is checked without fences', async () => {
	await expect(
		checkMermaidMarkdown({
			source: '<stdin>',
			content: githubPlusNoteDiagram,
		}),
	).resolves.toEqual([
		expect.objectContaining({
			file: '<stdin>',
			line: 8,
			message: expect.stringContaining("got '+'"),
		}),
	])
	await expect(
		checkMermaidMarkdown({
			source: '<stdin>',
			content: 'Just a PR description with no diagram.',
		}),
	).resolves.toEqual([])
})

test('unclosed and empty mermaid fences fail', async () => {
	await expect(
		checkMermaidMarkdown({
			source: 'docs/example.md',
			content: '```mermaid\nsequenceDiagram\n',
		}),
	).resolves.toEqual([
		expect.objectContaining({
			file: 'docs/example.md',
			line: 1,
			message: 'Unclosed mermaid fence',
		}),
	])
	await expect(
		checkMermaidMarkdown({
			source: 'docs/example.md',
			content: '```mermaid\n```\n',
		}),
	).resolves.toEqual([
		expect.objectContaining({
			file: 'docs/example.md',
			line: 1,
			message: 'Empty mermaid diagram',
		}),
	])
})

test('parseMermaidCheckArgs rejects mixed stdin and files', () => {
	expect(parseMermaidCheckArgs(['--stdin', 'docs/a.md'])).toEqual({
		error: 'use either --stdin or file paths, not both',
	})
	expect(parseMermaidCheckArgs(['--stdin', '--label', 'recap.md'])).toEqual({
		stdin: true,
		label: 'recap.md',
		files: [],
	})
})

test('checkMermaidSyntax scans docs and skills in a temp tree', async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), 'mermaid-check-'))
	try {
		await Promise.all([
			mkdir(path.join(cwd, 'docs', 'contributing'), { recursive: true }),
			mkdir(path.join(cwd, '.agents', 'skills', 'visual-recap'), {
				recursive: true,
			}),
		])
		await Promise.all([
			writeFile(path.join(cwd, 'README.md'), 'No diagram.\n'),
			writeFile(path.join(cwd, 'AGENTS.md'), 'No diagram.\n'),
			writeFile(
				path.join(cwd, 'docs', 'contributing', 'ok.md'),
				['```mermaid', visualRecapSequence, '```', ''].join('\n'),
			),
			writeFile(
				path.join(cwd, '.agents', 'skills', 'visual-recap', 'SKILL.md'),
				['```mermaid', githubPlusNoteDiagram, '```', ''].join('\n'),
			),
		])

		expect(await listMermaidSourcePaths(cwd)).toEqual([
			'.agents/skills/visual-recap/SKILL.md',
			'AGENTS.md',
			'README.md',
			'docs/contributing/ok.md',
		])
		expect(await checkMermaidSyntax(cwd)).toEqual([
			expect.objectContaining({
				file: '.agents/skills/visual-recap/SKILL.md',
				message: expect.stringContaining("got '+'"),
			}),
		])
	} finally {
		await rm(cwd, { recursive: true, force: true })
	}
})

test('repo mermaid fences currently parse', async () => {
	await expect(checkMermaidSyntax(repoRoot)).resolves.toEqual([])
})

test('CLI --stdin rejects the GitHub semicolon note diagram', () => {
	const recap = ['```mermaid', githubPlusNoteDiagram, '```', ''].join('\n')
	const result = spawnSync(
		process.execPath,
		[
			path.join(repoRoot, 'tools/check-mermaid-syntax.ts'),
			'--stdin',
			'--label',
			'recap.md',
		],
		{
			input: recap,
			encoding: 'utf8',
			cwd: repoRoot,
		},
	)
	expect(result.status).toBe(1)
	expect(result.stderr).toContain("got '+'")
	expect(result.stderr).toContain('recap.md:9:')
})
