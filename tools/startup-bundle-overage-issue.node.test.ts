import { expect, test } from 'vitest'
import { collectStartupBundleOverages } from './check-worker-startup-bundles.ts'
import {
	buildStartupBundleOverageIssueBody,
	formatStartupBundleOverageWarning,
	reportStartupBundleOverages,
	resolveStartupBundleOverageRunUrl,
	shouldReportStartupBundleOverageIssue,
	startupBundleOverageIssueMarker,
	startupBundleOverageIssueTitle,
	upsertStartupBundleOverageIssue,
} from './startup-bundle-overage-issue.ts'

test('collectStartupBundleOverages keeps the #2764-sized 88-byte spill as a report, not a hard fail input', () => {
	const overages = collectStartupBundleOverages([
		{ name: 'origin', size: 7_000_000, maxEntryBytes: 7_750_000 },
		{ name: 'platform', size: 5_238_546, maxEntryBytes: 5_238_600 },
		{ name: 'runtime', size: 3_912_588, maxEntryBytes: 3_912_500 },
	])
	expect(overages).toEqual([
		{
			name: 'runtime',
			size: 3_912_588,
			maxEntryBytes: 3_912_500,
			overage: 88,
		},
	])
})

test('overage issue titles and markers stay stable for dedupe', () => {
	expect(startupBundleOverageIssueTitle('runtime')).toBe(
		'Startup budget overage: runtime',
	)
	expect(startupBundleOverageIssueMarker('runtime')).toBe(
		'<!-- kody-startup-bundle-overage:runtime -->',
	)
	expect(
		buildStartupBundleOverageIssueBody({
			name: 'runtime',
			size: 3_912_588,
			maxEntryBytes: 3_912_500,
			overage: 88,
		}),
	).toContain('<!-- kody-startup-bundle-overage:runtime -->')
	expect(
		formatStartupBundleOverageWarning({
			name: 'runtime',
			size: 3_912_588,
			maxEntryBytes: 3_912_500,
			overage: 88,
		}),
	).toMatch(/warning only; does not fail CI/)
})

test('issue reporting is limited to main CI pushes with a token', () => {
	expect(
		shouldReportStartupBundleOverageIssue({
			CI: '1',
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/heads/main',
			GH_TOKEN: 'token',
		}),
	).toBe(true)
	expect(
		shouldReportStartupBundleOverageIssue({
			CI: '1',
			GITHUB_EVENT_NAME: 'pull_request',
			GITHUB_REF: 'refs/heads/main',
			GH_TOKEN: 'token',
		}),
	).toBe(false)
	expect(
		shouldReportStartupBundleOverageIssue({
			CI: '1',
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/heads/main',
		}),
	).toBe(false)
})

test('resolves the Actions run URL from standard GitHub env vars', () => {
	expect(
		resolveStartupBundleOverageRunUrl({
			GITHUB_SERVER_URL: 'https://github.com',
			GITHUB_REPOSITORY: 'kentcdodds/kody',
			GITHUB_RUN_ID: '123',
		}),
	).toBe('https://github.com/kentcdodds/kody/actions/runs/123')
})

test('upsertStartupBundleOverageIssue creates once then updates', () => {
	const calls: Array<Array<string>> = []
	let existing: { number: number; title: string; body: string } | null = null
	const gh = (args: Array<string>) => {
		calls.push(args)
		if (args[0] === 'issue' && args[1] === 'create') {
			existing = {
				number: 42,
				title: startupBundleOverageIssueTitle('runtime'),
				body: 'created',
			}
			return 'https://github.com/kentcdodds/kody/issues/42\n'
		}
		return ''
	}
	const findOpen = () => existing
	const overage = {
		name: 'runtime' as const,
		size: 3_912_588,
		maxEntryBytes: 3_912_500,
		overage: 88,
	}
	const env = {
		CI: '1',
		GITHUB_EVENT_NAME: 'push',
		GITHUB_REF: 'refs/heads/main',
		GH_TOKEN: 'token',
	}
	expect(
		upsertStartupBundleOverageIssue(overage, { env, gh, findOpen }),
	).toEqual({
		action: 'created',
		name: 'runtime',
		url: 'https://github.com/kentcdodds/kody/issues/42',
	})
	expect(
		upsertStartupBundleOverageIssue(overage, { env, gh, findOpen }),
	).toEqual({
		action: 'updated',
		name: 'runtime',
		number: 42,
	})
	expect(calls.some((args) => args[1] === 'create')).toBe(true)
	expect(calls.some((args) => args[1] === 'edit')).toBe(true)
	expect(calls.some((args) => args[1] === 'comment')).toBe(true)
})

function reportingEnv() {
	return {
		CI: '1',
		GITHUB_EVENT_NAME: 'push',
		GITHUB_REF: 'refs/heads/main',
		GH_TOKEN: 'token',
	}
}

function listSearchQuery(args: Array<string>) {
	const index = args.indexOf('--search')
	return index === -1 ? null : (args[index + 1] ?? null)
}

test('canonical title search updates the open issue without a labeled-list scan', () => {
	const calls: Array<Array<string>> = []
	const titled = {
		number: 42,
		title: startupBundleOverageIssueTitle('runtime'),
		body: 'earlier measure',
	}
	const gh = (args: Array<string>) => {
		calls.push(args)
		if (args[0] === 'issue' && args[1] === 'list') {
			return JSON.stringify([titled])
		}
		return ''
	}
	expect(
		upsertStartupBundleOverageIssue(
			{
				name: 'runtime',
				size: 3_912_588,
				maxEntryBytes: 3_912_500,
				overage: 88,
			},
			{
				env: reportingEnv(),
				gh,
			},
		),
	).toEqual({
		action: 'updated',
		name: 'runtime',
		number: 42,
	})
	expect(listSearchQuery(calls[0] ?? [])).toBe(
		'"Startup budget overage: runtime" in:title',
	)
	expect(calls.filter((args) => args[1] === 'list')).toHaveLength(1)
	expect(calls.some((args) => args.includes('--label'))).toBe(false)
	expect(calls.some((args) => args[1] === 'create')).toBe(false)
})

test('renamed open tracking issue is found by local marker match, not GitHub comment search', () => {
	const calls: Array<Array<string>> = []
	const marker = startupBundleOverageIssueMarker('runtime')
	const renamed = {
		number: 77,
		title: 'Startup growth to investigate (runtime)',
		body: `${marker}\nMeasured earlier.`,
	}
	const gh = (args: Array<string>) => {
		calls.push(args)
		if (args[0] === 'issue' && args[1] === 'list') {
			if (listSearchQuery(args) !== null) {
				return JSON.stringify([])
			}
			return JSON.stringify([renamed])
		}
		return ''
	}
	const result = upsertStartupBundleOverageIssue(
		{
			name: 'runtime',
			size: 3_912_588,
			maxEntryBytes: 3_912_500,
			overage: 88,
		},
		{
			env: reportingEnv(),
			gh,
		},
	)
	expect(result).toEqual({
		action: 'updated',
		name: 'runtime',
		number: 77,
	})
	const titleSearch = calls.find((args) => listSearchQuery(args) !== null)
	const labeledList = calls.find(
		(args) => args[1] === 'list' && args.includes('--label'),
	)
	expect(listSearchQuery(titleSearch ?? [])).toBe(
		'"Startup budget overage: runtime" in:title',
	)
	expect(labeledList).toContain('--label')
	expect(labeledList).toContain('friction')
	expect(calls.some((args) => args[1] === 'create')).toBe(false)
	expect(calls.some((args) => args[1] === 'edit' && args[2] === '77')).toBe(
		true,
	)
})

test('rejected title search still creates when no labeled issue exists', () => {
	const calls: Array<Array<string>> = []
	const gh = (args: Array<string>) => {
		calls.push(args)
		if (args[0] === 'issue' && args[1] === 'list') {
			if (listSearchQuery(args) !== null) {
				throw new Error('Invalid search query')
			}
			return JSON.stringify([])
		}
		if (args[0] === 'issue' && args[1] === 'create') {
			return 'https://github.com/kentcdodds/kody/issues/99\n'
		}
		return ''
	}
	expect(
		upsertStartupBundleOverageIssue(
			{
				name: 'runtime',
				size: 3_912_588,
				maxEntryBytes: 3_912_500,
				overage: 88,
			},
			{
				env: reportingEnv(),
				gh,
			},
		),
	).toEqual({
		action: 'created',
		name: 'runtime',
		url: 'https://github.com/kentcdodds/kody/issues/99',
	})
	expect(calls.some((args) => args[1] === 'create')).toBe(true)
})

test('reportStartupBundleOverages never throws when upsert fails', () => {
	const logs: Array<string> = []
	const actions = reportStartupBundleOverages(
		[
			{
				name: 'runtime',
				size: 3_912_588,
				maxEntryBytes: 3_912_500,
				overage: 88,
			},
		],
		{
			env: {
				CI: '1',
				GITHUB_EVENT_NAME: 'push',
				GITHUB_REF: 'refs/heads/main',
				GH_TOKEN: 'token',
			},
			upsert: () => {
				throw new Error('gh unavailable')
			},
			log: (message) => logs.push(message),
		},
	)
	expect(actions).toEqual([
		{
			action: 'skipped',
			name: 'runtime',
			reason: 'gh unavailable',
		},
	])
	expect(logs.join('\n')).toMatch(/does not fail CI/)
	expect(logs.join('\n')).toMatch(/Failed to upsert/)
})
