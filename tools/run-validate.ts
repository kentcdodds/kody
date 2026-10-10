import { spawn } from 'node:child_process'
import { availableParallelism, totalmem } from 'node:os'
import concurrently from 'concurrently'
import { isExecutedDirectly } from './node-runtime.ts'
import {
	formatValidatePlan,
	type ValidateLeg,
	validateConcurrency,
	validateLegsByWeight,
	serialValidateCommand,
} from './validate-gate.ts'

export type ValidatePoolResult = {
	ok: boolean
	failed: string[]
}

export function failedValidateLegNames(events: unknown): string[] {
	if (!Array.isArray(events)) {
		throw new Error('validate pool failed without a close-event list')
	}
	const names: Array<string> = []
	for (const event of events) {
		if (!event || typeof event !== 'object') continue
		const exitCode = 'exitCode' in event ? event.exitCode : undefined
		const command = 'command' in event ? event.command : undefined
		const name =
			command && typeof command === 'object' && 'name' in command
				? command.name
				: undefined
		if (
			typeof exitCode === 'number' &&
			exitCode !== 0 &&
			typeof name === 'string'
		) {
			names.push(name)
		}
	}
	if (names.length === 0) {
		throw new Error('validate pool failed without a named leg')
	}
	return names
}

export async function runValidatePool(input: {
	legs: readonly ValidateLeg[]
	maxProcesses: number | undefined
}): Promise<ValidatePoolResult> {
	if (input.legs.length === 0) return { ok: true, failed: [] }
	const { result } = concurrently(
		input.legs.map((leg) => ({ command: leg.command, name: leg.name })),
		{
			maxProcesses: input.maxProcesses,
			prefix: 'name',
			padPrefix: true,
		},
	)
	try {
		await result
		return { ok: true, failed: [] }
	} catch (events: unknown) {
		return { ok: false, failed: failedValidateLegNames(events) }
	}
}

export function runShellCommand(command: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, { shell: true, stdio: 'inherit' })
		child.once('error', reject)
		child.once('close', (code) => {
			resolve(code ?? 1)
		})
	})
}

export async function runValidate(
	options: {
		availableParallelism?: number
		totalMemoryBytes?: number
		log?: (line: string) => void
		runPool?: (input: {
			legs: readonly ValidateLeg[]
			maxProcesses: number | undefined
		}) => Promise<ValidatePoolResult>
		runSerial?: (command: string) => Promise<number>
	} = {},
): Promise<number> {
	const cores = options.availableParallelism ?? availableParallelism()
	const totalMemoryBytes = options.totalMemoryBytes ?? totalmem()
	const slots = validateConcurrency({
		availableParallelism: cores,
		totalMemoryBytes,
	})
	const log =
		options.log ??
		((line: string) => {
			console.log(line)
		})
	log(
		formatValidatePlan({
			availableParallelism: cores,
			totalMemoryBytes,
			slots,
		}),
	)
	const grouped = validateLegsByWeight()
	const runPool = options.runPool ?? runValidatePool
	const [suite, build, check] = await Promise.all([
		runPool({ legs: grouped.suite, maxProcesses: slots.suite }),
		runPool({ legs: grouped.build, maxProcesses: slots.build }),
		runPool({ legs: grouped.check, maxProcesses: slots.check }),
	])
	const failed = [...suite.failed, ...build.failed, ...check.failed]
	if (failed.length > 0) {
		log(`validate: failed legs: ${failed.join(', ')}`)
		return 1
	}
	const runSerial = options.runSerial ?? runShellCommand
	const status = await runSerial(serialValidateCommand)
	return status === 0 ? 0 : status
}

if (isExecutedDirectly(import.meta.url)) {
	const status = await runValidate()
	process.exit(status)
}
