import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'

export const routeSchema = z.enum([
	'existing',
	'execute-one-off',
	'ad-hoc-job',
	'package-authoring',
])

export const actionSchema = z.enum([
	'search',
	'invoke-existing',
	'execute-one-off',
	'schedule-ad-hoc-job',
	'inspect-authoring-guidance',
	'author-package',
	'other-execute',
])

const inventorySchema = z.discriminatedUnion('mode', [
	z
		.object({
			mode: z.literal('controlled'),
			precondition: z.string().min(1),
		})
		.strict(),
	z
		.object({
			mode: z.literal('inventory-dependent'),
			eligibility: z.string().min(1),
		})
		.strict(),
])

export const evalSetSchema = z
	.object({
		schemaVersion: z.literal(2),
		name: z.literal('package-discovery-routing'),
		actionCardinality: z
			.object({
				searchMinimum: z.literal(1),
				readOnlyMaximum: z.literal(3),
				authoringStepMaximum: z.literal(8),
			})
			.strict(),
		cases: z
			.array(
				z
					.object({
						id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
						prompt: z.string().min(1),
						inventory: inventorySchema,
						expected: z
							.object({
								route: routeSchema,
								requiredActions: z.array(actionSchema).min(1),
								allowedActions: z.array(actionSchema).min(1),
								terminalAction: actionSchema,
							})
							.strict(),
					})
					.strict(),
			)
			.min(1),
	})
	.strict()

const requiredOutputSchema = z.custom<unknown>(
	(value) => value !== undefined,
	'output is required',
)
const traceBaseSchema = z.object({
	callId: z.string().min(1),
	status: z.enum(['succeeded', 'failed']),
	input: z.record(z.string(), z.unknown()),
	output: requiredOutputSchema,
})

const searchCallSchema = traceBaseSchema
	.extend({
		action: z.literal('search'),
		toolName: z.literal('search'),
		match: z.discriminatedUnion('kind', [
			z
				.object({
					kind: z.literal('exact-reusable'),
					entityId: z.string().min(1),
				})
				.strict(),
			z.object({ kind: z.literal('no-exact-reusable') }).strict(),
		]),
	})
	.strict()

const executeCallSchema = traceBaseSchema
	.extend({
		action: z.enum([
			'execute-one-off',
			'schedule-ad-hoc-job',
			'inspect-authoring-guidance',
			'author-package',
			'other-execute',
		]),
		toolName: z.literal('execute'),
	})
	.strict()

const invokeExistingCallSchema = traceBaseSchema
	.extend({
		action: z.literal('invoke-existing'),
		toolName: z.literal('execute'),
		targetEntityId: z.string().min(1),
	})
	.strict()

export const traceCallSchema = z.discriminatedUnion('action', [
	searchCallSchema,
	invokeExistingCallSchema,
	executeCallSchema,
])

const completedResultSchema = z
	.object({
		caseId: z.string().min(1),
		outcome: z.literal('completed'),
		events: z.array(traceCallSchema),
	})
	.strict()

const skippedResultSchema = z
	.object({
		caseId: z.string().min(1),
		outcome: z.literal('skipped-no-eligible-match'),
		note: z.string().min(1),
	})
	.strict()

export const transcriptSchema = z
	.object({
		schemaVersion: z.literal(1),
		evalName: z.literal('package-discovery-routing'),
		host: z.enum(['warp', 'cursor', 'claude', 'chatgpt']),
		model: z.string().min(1),
		runAt: z.iso.datetime(),
		results: z
			.array(
				z.discriminatedUnion('outcome', [
					completedResultSchema,
					skippedResultSchema,
				]),
			)
			.min(1),
	})
	.strict()

type EvalSet = z.infer<typeof evalSetSchema>
type Transcript = z.infer<typeof transcriptSchema>

type CaseScore = {
	caseId: string
	route: z.infer<typeof routeSchema>
	status: 'passed' | 'failed' | 'skipped'
	errors: Array<string>
}

export type ScoreReport = {
	ok: boolean
	host: Transcript['host']
	model: string
	totals: {
		passed: number
		failed: number
		skipped: number
		total: number
	}
	byRoute: Record<
		z.infer<typeof routeSchema>,
		{ passed: number; failed: number; skipped: number; total: number }
	>
	cases: Array<CaseScore>
	errors: Array<string>
}

export function loadPackageDiscoveryEval(): EvalSet {
	const raw: unknown = JSON.parse(
		readFileSync(
			new URL('./package-discovery-routing.json', import.meta.url),
			'utf8',
		),
	)
	return evalSetSchema.parse(raw)
}

function countMatches(value: string, pattern: RegExp): number {
	return Array.from(value.matchAll(pattern)).length
}

function scoreCompletedResult(
	evalCase: EvalSet['cases'][number],
	result: z.infer<typeof completedResultSchema>,
	actionCardinality: EvalSet['actionCardinality'],
): Array<string> {
	const errors: Array<string> = []
	const actions = result.events.map(({ action }) => action)
	const allowedActions = new Set(evalCase.expected.allowedActions)
	const actionCounts = new Map<z.infer<typeof actionSchema>, number>()
	for (const action of actions) {
		actionCounts.set(action, (actionCounts.get(action) ?? 0) + 1)
	}

	if (actions[0] !== 'search') {
		errors.push('first action must be search')
	}
	const searchCount = actionCounts.get('search') ?? 0
	if (searchCount < actionCardinality.searchMinimum) {
		errors.push(
			`expected at least ${actionCardinality.searchMinimum} search action, received ${searchCount}`,
		)
	}
	if (actions.at(-1) !== evalCase.expected.terminalAction) {
		errors.push(`terminal action must be ${evalCase.expected.terminalAction}`)
	}
	const terminalCount = actionCounts.get(evalCase.expected.terminalAction) ?? 0
	if (evalCase.expected.route !== 'package-authoring' && terminalCount !== 1) {
		errors.push(
			`expected exactly 1 ${evalCase.expected.terminalAction} action, received ${terminalCount}`,
		)
	}
	if (
		evalCase.expected.route === 'package-authoring' &&
		terminalCount > actionCardinality.authoringStepMaximum
	) {
		errors.push(
			`author-package action may appear at most ${actionCardinality.authoringStepMaximum} times, received ${terminalCount}`,
		)
	}
	for (const requiredAction of evalCase.expected.requiredActions) {
		if (!actions.includes(requiredAction)) {
			errors.push(`missing required action ${requiredAction}`)
		}
	}
	for (const action of actions) {
		if (!allowedActions.has(action)) {
			errors.push(`extraneous action ${action}`)
		}
	}
	const inspectionCount = actionCounts.get('inspect-authoring-guidance') ?? 0
	const readOnlyCount = searchCount + inspectionCount
	if (readOnlyCount > actionCardinality.readOnlyMaximum) {
		errors.push(
			`read-only actions may appear at most ${actionCardinality.readOnlyMaximum} times, received ${readOnlyCount}`,
		)
	}
	if (result.events.some(({ status }) => status === 'failed')) {
		errors.push('trace contains a failed tool call')
	}

	const payloadsByCallId = new Map<
		string,
		{ input: Record<string, unknown>; output: unknown }
	>()
	for (const { callId, input, output } of result.events) {
		const firstPayload = payloadsByCallId.get(callId)
		if (!firstPayload) {
			payloadsByCallId.set(callId, { input, output })
		} else if (
			!isDeepStrictEqual(firstPayload.input, input) ||
			!isDeepStrictEqual(firstPayload.output, output)
		) {
			errors.push(`${callId} has inconsistent input or output payloads`)
		}
	}

	let authoringMutationCount = 0
	const countedAuthoringCallIds = new Set<string>()
	for (const event of result.events) {
		if (event.toolName !== 'execute') continue
		const code = event.input.code
		if (typeof code !== 'string') {
			errors.push(`${event.action} event is missing execute input.code`)
			continue
		}
		const hasScheduleOperation = /\bjob_schedule(?:_once)?\b/.test(code)
		const authoringOperationCount = countMatches(
			code,
			/\b(?:package_save|package_get_git_remote|package_publish_external_push|repo_open_session|repo_write_file|repo_run_commands|repo_run_checks|repo_publish_session)\b/g,
		)
		const eventAuthoringMutationCount = countMatches(
			code,
			/\b(?:package_save|package_publish_external_push|repo_write_file|repo_run_commands|repo_publish_session)\b/g,
		)
		const hasAuthorOperation = authoringOperationCount > 0
		if (!countedAuthoringCallIds.has(event.callId)) {
			countedAuthoringCallIds.add(event.callId)
			authoringMutationCount += eventAuthoringMutationCount
		}
		const sameCallActions = new Set(
			result.events
				.filter(({ callId }) => callId === event.callId)
				.map(({ action }) => action),
		)
		if (hasScheduleOperation && !sameCallActions.has('schedule-ad-hoc-job')) {
			errors.push(
				`${event.callId} contains an unrecorded schedule-ad-hoc-job action`,
			)
		}
		if (hasAuthorOperation && !sameCallActions.has('author-package')) {
			errors.push(
				`${event.callId} contains an unrecorded author-package action`,
			)
		}
		if (event.action === 'schedule-ad-hoc-job' && !hasScheduleOperation) {
			errors.push('schedule-ad-hoc-job evidence has no scheduling operation')
		}
		if (event.action === 'author-package' && !hasAuthorOperation) {
			errors.push('author-package evidence has no authoring operation')
		}
		if (
			event.action === 'inspect-authoring-guidance' &&
			!/\b(?:coding_guide_get|package_get)\b/.test(code)
		) {
			errors.push('inspect-authoring-guidance evidence has no guidance read')
		}
		if (
			event.action === 'execute-one-off' &&
			(hasScheduleOperation || hasAuthorOperation)
		) {
			errors.push('execute-one-off evidence contains a persistent operation')
		}
		if (
			event.action === 'invoke-existing' &&
			!code.includes(event.targetEntityId)
		) {
			errors.push('invoke-existing evidence does not contain its target id')
		}
	}
	if (evalCase.expected.route === 'package-authoring') {
		if (authoringMutationCount < 1) {
			errors.push('package authoring requires at least one mutation')
		}
	}

	const searchCalls = result.events.filter(
		(call): call is z.infer<typeof searchCallSchema> =>
			call.action === 'search',
	)
	if (evalCase.expected.route === 'existing') {
		const exactMatchIds = searchCalls.flatMap(({ match }) =>
			match.kind === 'exact-reusable' ? [match.entityId] : [],
		)
		const invocation = result.events.find(
			(call): call is z.infer<typeof invokeExistingCallSchema> =>
				call.action === 'invoke-existing',
		)
		if (exactMatchIds.length === 0) {
			errors.push('search did not record an exact reusable match')
		}
		if (invocation && !exactMatchIds.includes(invocation.targetEntityId)) {
			errors.push('invocation target does not match the discovered entity')
		}
	} else if (searchCalls.some(({ match }) => match.kind === 'exact-reusable')) {
		errors.push('non-reuse route ignored an exact reusable match')
	}

	return errors
}

export function scorePackageDiscoveryTranscript(
	rawEvalSet: unknown,
	rawTranscript: unknown,
): ScoreReport {
	const evalSet = evalSetSchema.parse(rawEvalSet)
	const transcript = transcriptSchema.parse(rawTranscript)
	const evalCasesById = new Map(
		evalSet.cases.map((evalCase) => [evalCase.id, evalCase]),
	)
	const resultsByCaseId = new Map<string, Transcript['results'][number]>()
	const reportErrors: Array<string> = []

	for (const result of transcript.results) {
		if (resultsByCaseId.has(result.caseId)) {
			reportErrors.push(`duplicate result for ${result.caseId}`)
		} else if (!evalCasesById.has(result.caseId)) {
			reportErrors.push(`unknown case ${result.caseId}`)
		} else {
			resultsByCaseId.set(result.caseId, result)
		}
	}

	const cases: Array<CaseScore> = evalSet.cases.map((evalCase) => {
		const result = resultsByCaseId.get(evalCase.id)
		if (!result) {
			return {
				caseId: evalCase.id,
				route: evalCase.expected.route,
				status: 'failed',
				errors: ['missing result'],
			}
		}
		if (result.outcome === 'skipped-no-eligible-match') {
			if (evalCase.inventory.mode !== 'inventory-dependent') {
				return {
					caseId: evalCase.id,
					route: evalCase.expected.route,
					status: 'failed',
					errors: ['controlled-inventory case cannot be skipped'],
				}
			}
			return {
				caseId: evalCase.id,
				route: evalCase.expected.route,
				status: 'skipped',
				errors: [],
			}
		}

		const errors = scoreCompletedResult(
			evalCase,
			result,
			evalSet.actionCardinality,
		)
		return {
			caseId: evalCase.id,
			route: evalCase.expected.route,
			status: errors.length === 0 ? 'passed' : 'failed',
			errors,
		}
	})

	const emptyRouteScore = () => ({
		passed: 0,
		failed: 0,
		skipped: 0,
		total: 0,
	})
	const byRoute: ScoreReport['byRoute'] = {
		existing: emptyRouteScore(),
		'execute-one-off': emptyRouteScore(),
		'ad-hoc-job': emptyRouteScore(),
		'package-authoring': emptyRouteScore(),
	}
	for (const caseScore of cases) {
		const routeScore = byRoute[caseScore.route]
		routeScore.total += 1
		routeScore[caseScore.status] += 1
	}

	const totals = {
		passed: cases.filter(({ status }) => status === 'passed').length,
		failed: cases.filter(({ status }) => status === 'failed').length,
		skipped: cases.filter(({ status }) => status === 'skipped').length,
		total: cases.length,
	}
	return {
		ok: totals.failed === 0 && reportErrors.length === 0,
		host: transcript.host,
		model: transcript.model,
		totals,
		byRoute,
		cases,
		errors: reportErrors,
	}
}

function runCli() {
	const [command, transcriptPath] = process.argv.slice(2)
	if (command !== 'score' || !transcriptPath) {
		throw new Error(
			'Usage: node tools/evals/package-discovery-routing.ts score <transcript.json>',
		)
	}
	const transcript: unknown = JSON.parse(readFileSync(transcriptPath, 'utf8'))
	const report = scorePackageDiscoveryTranscript(
		loadPackageDiscoveryEval(),
		transcript,
	)
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
	if (!report.ok) process.exitCode = 1
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		runCli()
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		)
		process.exitCode = 1
	}
}
