import { expect, test } from 'vitest'
import {
	actionSchema,
	loadPackageDiscoveryEval,
	routeSchema,
	scorePackageDiscoveryTranscript,
	transcriptSchema,
} from './package-discovery-routing.ts'

const createPassingTranscript = (): unknown => {
	const evalSet = loadPackageDiscoveryEval()
	return {
		schemaVersion: 1 as const,
		evalName: 'package-discovery-routing' as const,
		host: 'cursor' as const,
		model: 'test-model',
		runAt: '2026-07-14T21:00:00.000Z',
		results: evalSet.cases.map((evalCase) => {
			const entityId = `fixture:${evalCase.id}`
			const searchCall = {
				callId: `search:${evalCase.id}`,
				action: 'search' as const,
				toolName: 'search' as const,
				status: 'succeeded' as const,
				input: { query: evalCase.prompt },
				output: { result: 'captured search output' },
				match:
					evalCase.expected.route === 'existing'
						? ({
								kind: 'exact-reusable' as const,
								entityId,
							} as const)
						: ({ kind: 'no-exact-reusable' as const } as const),
			}
			const terminalAction = evalCase.expected.terminalAction
			const terminalCall =
				terminalAction === 'invoke-existing'
					? ({
							callId: `execute:${evalCase.id}`,
							action: terminalAction,
							toolName: 'execute' as const,
							status: 'succeeded' as const,
							input: {
								code: `import ${JSON.stringify(entityId)}`,
							},
							output: { result: 'captured invocation output' },
							targetEntityId: entityId,
						} as const)
					: ({
							callId: `execute:${evalCase.id}`,
							action: terminalAction,
							toolName: 'execute' as const,
							status: 'succeeded' as const,
							input: {
								code:
									terminalAction === 'schedule-ad-hoc-job'
										? 'await kody.job_schedule_once({})'
										: terminalAction === 'author-package'
											? 'await kody.package_save({})'
											: 'return await kody.value_list({})',
							},
							output: { result: 'captured execution output' },
						} as const)
			const searchCalls =
				evalCase.expected.route === 'existing'
					? [
							{
								...searchCall,
								callId: `${searchCall.callId}:query`,
								match: { kind: 'no-exact-reusable' as const },
							},
							{
								...searchCall,
								callId: `${searchCall.callId}:entity`,
								input: { entity: entityId },
							},
						]
					: [searchCall]
			return {
				caseId: evalCase.id,
				outcome: 'completed' as const,
				events: [...searchCalls, terminalCall],
			}
		}),
	}
}

test('routing cases are natural, balanced, and have internally consistent hidden expectations', () => {
	const evalSet = loadPackageDiscoveryEval()
	const routeCounts = Object.fromEntries(
		evalSet.cases.map(({ expected }) => [expected.route, 0]),
	)

	expect(new Set(evalSet.cases.map(({ id }) => id)).size).toBe(
		evalSet.cases.length,
	)
	for (const evalCase of evalSet.cases) {
		expect(evalCase.prompt).not.toMatch(/\bpackage\b/i)
		for (const hiddenLabel of [
			...routeSchema.options,
			...actionSchema.options,
		]) {
			expect(evalCase.prompt).not.toContain(hiddenLabel)
		}
		expect(
			evalCase.expected.requiredActions.every((action) =>
				evalCase.expected.allowedActions.includes(action),
			),
		).toBe(true)
		expect(evalCase.expected.requiredActions).toContain(
			evalCase.expected.terminalAction,
		)
		routeCounts[evalCase.expected.route] += 1
	}
	expect(routeCounts).toEqual({
		existing: 2,
		'execute-one-off': 2,
		'ad-hoc-job': 2,
		'package-authoring': 2,
	})
	expect(evalSet.actionCardinality).toEqual({
		searchMinimum: 1,
		readOnlyMaximum: 3,
		authoringStepMaximum: 5,
	})
	expect(
		evalSet.cases
			.filter(({ expected }) => expected.route === 'existing')
			.every(({ inventory }) => inventory.mode === 'inventory-dependent'),
	).toBe(true)
})

test('scorer accepts exact traces and reports two passes per route', () => {
	const evalSet = loadPackageDiscoveryEval()
	const transcript = transcriptSchema.parse(createPassingTranscript())
	const report = scorePackageDiscoveryTranscript(evalSet, transcript)

	expect(report.ok).toBe(true)
	expect(report.totals).toEqual({
		passed: 8,
		failed: 0,
		skipped: 0,
		total: 8,
	})
	for (const routeScore of Object.values(report.byRoute)) {
		expect(routeScore).toEqual({
			passed: 2,
			failed: 0,
			skipped: 0,
			total: 2,
		})
	}
})

test('scorer rejects wrong targets, extraneous actions, failed calls, and invalid skips', () => {
	const evalSet = loadPackageDiscoveryEval()
	const transcript = structuredClone(
		transcriptSchema.parse(createPassingTranscript()),
	)
	const existingResult = transcript.results[0]
	const oneOffResult = transcript.results[2]
	const controlledResult = transcript.results[4]
	const noTraceResult = transcript.results[5]
	if (
		!existingResult ||
		!oneOffResult ||
		!controlledResult ||
		!noTraceResult ||
		existingResult.outcome !== 'completed' ||
		oneOffResult.outcome !== 'completed' ||
		noTraceResult.outcome !== 'completed'
	) {
		throw new Error('Expected completed scorer fixtures.')
	}

	const invocation = existingResult.events.find(
		(event) => event.action === 'invoke-existing',
	)
	if (!invocation || invocation.action !== 'invoke-existing') {
		throw new Error('Expected an existing-result invocation fixture.')
	}
	invocation.targetEntityId = 'fixture:wrong-target'
	oneOffResult.events.splice(1, 0, {
		callId: `execute:${oneOffResult.caseId}:wrong`,
		action: 'author-package',
		toolName: 'execute',
		status: 'failed',
		input: { code: 'await kody.package_save({})' },
		output: { error: 'failed' },
	})
	transcript.results[4] = {
		caseId: controlledResult.caseId,
		outcome: 'skipped-no-eligible-match',
		note: 'incorrect skip',
	}
	noTraceResult.events = []

	const report = scorePackageDiscoveryTranscript(evalSet, transcript)
	expect(report.ok).toBe(false)
	expect(report.totals.failed).toBe(4)
	expect(report.cases[0]?.errors).toContain(
		'invocation target does not match the discovered entity',
	)
	expect(report.cases[2]?.errors).toEqual(
		expect.arrayContaining([
			'extraneous action author-package',
			'trace contains a failed tool call',
		]),
	)
	expect(report.cases[4]?.errors).toContain(
		'controlled-inventory case cannot be skipped',
	)
	expect(report.cases[5]?.errors).toEqual(
		expect.arrayContaining([
			'first action must be search',
			'missing required action schedule-ad-hoc-job',
		]),
	)
	expect(actionSchema.safeParse('explain-only').success).toBe(false)
})

test('scorer rejects duplicate successful scheduling mutations', () => {
	const evalSet = loadPackageDiscoveryEval()
	const transcript = structuredClone(
		transcriptSchema.parse(createPassingTranscript()),
	)
	const scheduleResult = transcript.results[4]
	if (!scheduleResult || scheduleResult.outcome !== 'completed') {
		throw new Error('Expected a completed scheduling fixture.')
	}
	const scheduleEvent = scheduleResult.events[1]
	if (!scheduleEvent || scheduleEvent.action !== 'schedule-ad-hoc-job') {
		throw new Error('Expected a scheduling event fixture.')
	}
	scheduleResult.events.push({
		...scheduleEvent,
		callId: `${scheduleEvent.callId}:duplicate`,
	})

	const report = scorePackageDiscoveryTranscript(evalSet, transcript)
	expect(report.ok).toBe(false)
	expect(report.totals.failed).toBe(1)
	expect(report.cases[4]?.errors).toContain(
		'expected exactly 1 schedule-ad-hoc-job action, received 2',
	)
	expect(report.byRoute['ad-hoc-job']).toEqual({
		passed: 1,
		failed: 1,
		skipped: 0,
		total: 2,
	})
})

test('scorer accepts canonical git-lane authoring with repeated discovery and intermediate steps', () => {
	const evalSet = loadPackageDiscoveryEval()
	const transcript = structuredClone(
		transcriptSchema.parse(createPassingTranscript()),
	)
	const authoringResult = transcript.results[6]
	if (!authoringResult || authoringResult.outcome !== 'completed') {
		throw new Error('Expected a completed authoring fixture.')
	}
	authoringResult.events = [
		{
			callId: 'author-search-query',
			action: 'search',
			toolName: 'search',
			status: 'succeeded',
			input: { query: 'status brief automation' },
			output: { results: [] },
			match: { kind: 'no-exact-reusable' },
		},
		{
			callId: 'author-search-guide',
			action: 'search',
			toolName: 'search',
			status: 'succeeded',
			input: { entity: 'package-authoring-guide' },
			output: { result: 'guide capability' },
			match: { kind: 'no-exact-reusable' },
		},
		{
			callId: 'author-inspect',
			action: 'inspect-authoring-guidance',
			toolName: 'execute',
			status: 'succeeded',
			input: { code: 'await kody.coding_guide_get({})' },
			output: { guide: 'captured' },
		},
		{
			callId: 'author-initialize',
			action: 'author-package',
			toolName: 'execute',
			status: 'succeeded',
			input: { code: 'await kody.package_get_git_remote({})' },
			output: { remote: 'captured' },
		},
		{
			callId: 'author-edit',
			action: 'author-package',
			toolName: 'execute',
			status: 'succeeded',
			input: { code: 'await kody.repo_run_commands({})' },
			output: { edited: true },
		},
		{
			callId: 'author-publish',
			action: 'author-package',
			toolName: 'execute',
			status: 'succeeded',
			input: { code: 'await kody.package_publish_external_push({})' },
			output: { published: true },
		},
	]

	const report = scorePackageDiscoveryTranscript(evalSet, transcript)
	expect(report.ok).toBe(true)
	expect(report.totals).toEqual({
		passed: 8,
		failed: 0,
		skipped: 0,
		total: 8,
	})
})

test('scorer rejects duplicate successful package publications', () => {
	const evalSet = loadPackageDiscoveryEval()
	const transcript = structuredClone(
		transcriptSchema.parse(createPassingTranscript()),
	)
	const authoringResult = transcript.results[6]
	if (!authoringResult || authoringResult.outcome !== 'completed') {
		throw new Error('Expected a completed authoring fixture.')
	}
	authoringResult.events.push({
		callId: 'author-publish-duplicate',
		action: 'author-package',
		toolName: 'execute',
		status: 'succeeded',
		input: { code: 'await kody.package_publish_external_push({})' },
		output: { published: true },
	})

	const report = scorePackageDiscoveryTranscript(evalSet, transcript)
	expect(report.ok).toBe(false)
	expect(report.totals.failed).toBe(1)
	expect(report.cases[6]?.errors).toContain(
		'expected exactly 1 terminal authoring operation, received 2',
	)
	expect(report.byRoute['package-authoring']).toEqual({
		passed: 1,
		failed: 1,
		skipped: 0,
		total: 2,
	})
})
