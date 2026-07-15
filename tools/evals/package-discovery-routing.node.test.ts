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

function getByCaseId<T extends { caseId: string }>(
	items: ReadonlyArray<T>,
	caseId: string,
): T {
	const item = items.find((candidate) => candidate.caseId === caseId)
	if (!item) throw new Error(`Expected fixture for ${caseId}.`)
	return item
}

function requireCompletedResult(
	transcript: ReturnType<typeof transcriptSchema.parse>,
	caseId: string,
) {
	const result = getByCaseId(transcript.results, caseId)
	if (result.outcome !== 'completed') {
		throw new Error(`Expected a completed fixture for ${caseId}.`)
	}
	return result
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
		authoringStepMaximum: 8,
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

test('scorer rejects wrong targets, duplicates, payload drift, skips, and cardinality breaches', () => {
	const evalSet = loadPackageDiscoveryEval()
	const transcript = structuredClone(
		transcriptSchema.parse(createPassingTranscript()),
	)
	const existingResult = requireCompletedResult(
		transcript,
		'reuse-recurring-email-drafter',
	)
	const oneOffResult = requireCompletedResult(
		transcript,
		'one-off-saved-automation-count',
	)
	const controlledResult = getByCaseId(
		transcript.results,
		'schedule-single-reminder',
	)
	const noTraceResult = requireCompletedResult(
		transcript,
		'schedule-simple-recurring-reminder',
	)

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
	transcript.results.splice(transcript.results.indexOf(controlledResult), 1, {
		caseId: controlledResult.caseId,
		outcome: 'skipped-no-eligible-match',
		note: 'incorrect skip',
	})
	noTraceResult.events = []

	const invalidReport = scorePackageDiscoveryTranscript(evalSet, transcript)
	expect(invalidReport.ok).toBe(false)
	expect(invalidReport.totals.failed).toBe(4)
	expect(
		getByCaseId(invalidReport.cases, 'reuse-recurring-email-drafter').errors,
	).toContain('invocation target does not match the discovered entity')
	expect(
		getByCaseId(invalidReport.cases, 'one-off-saved-automation-count').errors,
	).toEqual(
		expect.arrayContaining([
			'extraneous action author-package',
			'trace contains a failed tool call',
		]),
	)
	expect(
		getByCaseId(invalidReport.cases, 'schedule-single-reminder').errors,
	).toContain('controlled-inventory case cannot be skipped')
	expect(
		getByCaseId(invalidReport.cases, 'schedule-simple-recurring-reminder')
			.errors,
	).toEqual(
		expect.arrayContaining([
			'first action must be search',
			'missing required action schedule-ad-hoc-job',
		]),
	)
	expect(actionSchema.safeParse('explain-only').success).toBe(false)

	const duplicateTranscript = structuredClone(
		transcriptSchema.parse(createPassingTranscript()),
	)
	const scheduleResult = requireCompletedResult(
		duplicateTranscript,
		'schedule-single-reminder',
	)
	const scheduleEvent = scheduleResult.events[1]
	if (!scheduleEvent || scheduleEvent.action !== 'schedule-ad-hoc-job') {
		throw new Error('Expected a scheduling event fixture.')
	}
	scheduleResult.events.push({
		...scheduleEvent,
		callId: `${scheduleEvent.callId}:duplicate`,
	})
	const duplicateReport = scorePackageDiscoveryTranscript(
		evalSet,
		duplicateTranscript,
	)
	expect(duplicateReport.ok).toBe(false)
	expect(duplicateReport.totals.failed).toBe(1)
	expect(
		getByCaseId(duplicateReport.cases, 'schedule-single-reminder').errors,
	).toContain('expected exactly 1 schedule-ad-hoc-job action, received 2')
	expect(duplicateReport.byRoute['ad-hoc-job']).toEqual({
		passed: 1,
		failed: 1,
		skipped: 0,
		total: 2,
	})

	const consistentTranscript = structuredClone(
		transcriptSchema.parse(createPassingTranscript()),
	)
	const authoringResult = requireCompletedResult(
		consistentTranscript,
		'author-reusable-scheduled-brief',
	)
	const authoringEvent = authoringResult.events.at(-1)
	if (!authoringEvent || authoringEvent.action !== 'author-package') {
		throw new Error('Expected an authoring event fixture.')
	}
	authoringEvent.input = {
		code: 'await kody.coding_guide_get({}); await kody.package_save({})',
	}
	authoringResult.events.splice(-1, 0, {
		...authoringEvent,
		action: 'inspect-authoring-guidance',
	})
	expect(
		scorePackageDiscoveryTranscript(evalSet, consistentTranscript).ok,
	).toBe(true)

	for (const mismatch of ['input', 'output'] as const) {
		const mismatchedTranscript = structuredClone(consistentTranscript)
		const mismatchedResult = requireCompletedResult(
			mismatchedTranscript,
			'author-reusable-scheduled-brief',
		)
		if (mismatch === 'input') {
			mismatchedResult.events.at(-1)!.input = {
				code: 'await kody.package_save({})',
			}
		} else {
			mismatchedResult.events.at(-1)!.output = { result: 'different output' }
		}
		const report = scorePackageDiscoveryTranscript(
			evalSet,
			mismatchedTranscript,
		)
		expect(report.ok).toBe(false)
		expect(
			getByCaseId(report.cases, 'author-reusable-scheduled-brief').errors,
		).toContain(
			'execute:author-reusable-scheduled-brief has inconsistent input or output payloads',
		)
	}

	const readOnlyTranscript = structuredClone(
		transcriptSchema.parse(createPassingTranscript()),
	)
	const readOnlyResult = requireCompletedResult(
		readOnlyTranscript,
		'author-reusable-scheduled-brief',
	)
	readOnlyResult.events.splice(
		-1,
		0,
		...Array.from({ length: 3 }, (_, index) => ({
			callId: `author-inspect-${index}`,
			action: 'inspect-authoring-guidance' as const,
			toolName: 'execute' as const,
			status: 'succeeded' as const,
			input: { code: 'await kody.coding_guide_get({})' },
			output: { guide: 'captured' },
		})),
	)
	expect(
		getByCaseId(
			scorePackageDiscoveryTranscript(evalSet, readOnlyTranscript).cases,
			'author-reusable-scheduled-brief',
		).errors,
	).toContain('read-only actions may appear at most 3 times, received 4')

	const authoringTranscript = structuredClone(
		transcriptSchema.parse(createPassingTranscript()),
	)
	const authoringLimitResult = requireCompletedResult(
		authoringTranscript,
		'author-reusable-scheduled-brief',
	)
	authoringLimitResult.events = [
		authoringLimitResult.events[0]!,
		...Array.from({ length: 9 }, (_, index) => ({
			callId: `author-mutation-${index}`,
			action: 'author-package' as const,
			toolName: 'execute' as const,
			status: 'succeeded' as const,
			input: { code: 'await kody.package_save({})' },
			output: { saved: true },
		})),
	]
	expect(
		getByCaseId(
			scorePackageDiscoveryTranscript(evalSet, authoringTranscript).cases,
			'author-reusable-scheduled-brief',
		).errors,
	).toContain('author-package action may appear at most 8 times, received 9')
})

test('scorer accepts git-lane, two-publish, and tool-only authoring variants', () => {
	const evalSet = loadPackageDiscoveryEval()
	const expectedTotals = {
		passed: 8,
		failed: 0,
		skipped: 0,
		total: 8,
	}

	const gitLaneTranscript = structuredClone(
		transcriptSchema.parse(createPassingTranscript()),
	)
	requireCompletedResult(
		gitLaneTranscript,
		'author-reusable-scheduled-brief',
	).events = [
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
	expect(
		scorePackageDiscoveryTranscript(evalSet, gitLaneTranscript),
	).toMatchObject({
		ok: true,
		totals: expectedTotals,
	})

	const twoPublishTranscript = structuredClone(
		transcriptSchema.parse(createPassingTranscript()),
	)
	const twoPublishResult = requireCompletedResult(
		twoPublishTranscript,
		'author-reusable-scheduled-brief',
	)
	twoPublishResult.events = [
		twoPublishResult.events[0]!,
		{
			callId: 'author-publish-disabled',
			action: 'author-package',
			toolName: 'execute',
			status: 'succeeded',
			input: { code: 'await kody.package_save({ enabled: false })' },
			output: { published: true, enabled: false },
		},
		{
			callId: 'author-test-disabled',
			action: 'author-package',
			toolName: 'execute',
			status: 'succeeded',
			input: { code: 'await kody.repo_run_commands({ commands: "test" })' },
			output: { passed: true },
		},
		{
			callId: 'author-publish-enabled',
			action: 'author-package',
			toolName: 'execute',
			status: 'succeeded',
			input: { code: 'await kody.package_save({ enabled: true })' },
			output: { published: true, enabled: true },
		},
	]
	expect(
		scorePackageDiscoveryTranscript(evalSet, twoPublishTranscript),
	).toMatchObject({
		ok: true,
		totals: expectedTotals,
	})

	const toolOnlyTranscript = structuredClone(
		transcriptSchema.parse(createPassingTranscript()),
	)
	const toolOnlyResult = requireCompletedResult(
		toolOnlyTranscript,
		'author-validated-cleanup-automation',
	)
	toolOnlyResult.events = [
		toolOnlyResult.events[0]!,
		{
			callId: 'tool-only-open',
			action: 'author-package',
			toolName: 'execute',
			status: 'succeeded',
			input: { code: 'await kody.repo_open_session({})' },
			output: { sessionId: 'repo-session' },
		},
		{
			callId: 'tool-only-write',
			action: 'author-package',
			toolName: 'execute',
			status: 'succeeded',
			input: { code: 'await kody.repo_write_file({})' },
			output: { written: true },
		},
		{
			callId: 'tool-only-commit',
			action: 'author-package',
			toolName: 'execute',
			status: 'succeeded',
			input: { code: 'await kody.repo_run_commands({})' },
			output: { committed: true },
		},
		{
			callId: 'tool-only-check',
			action: 'author-package',
			toolName: 'execute',
			status: 'succeeded',
			input: { code: 'await kody.repo_run_checks({})' },
			output: { passed: true },
		},
		{
			callId: 'tool-only-publish',
			action: 'author-package',
			toolName: 'execute',
			status: 'succeeded',
			input: { code: 'await kody.repo_publish_session({})' },
			output: { published: true },
		},
	]
	expect(
		scorePackageDiscoveryTranscript(evalSet, toolOnlyTranscript),
	).toMatchObject({
		ok: true,
		totals: expectedTotals,
	})
})
