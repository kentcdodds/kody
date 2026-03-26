export type ProcessOutputMode = 'live' | 'buffer-on-error'

type OutputTarget = 'stdout' | 'stderr'

type BufferedLine = {
	line: string
	target: OutputTarget
	sequence: number
}

const defaultMaxBufferedLines = 400

export function createProcessOutputController(options: {
	label: string
	mode: ProcessOutputMode
	filters?: Array<RegExp>
	stdout?: NodeJS.WritableStream
	stderr?: NodeJS.WritableStream
	maxBufferedLines?: number
}) {
	const filters = options.filters ?? []
	const stdout = options.stdout ?? process.stdout
	const stderr = options.stderr ?? process.stderr
	const maxBufferedLines =
		options.maxBufferedLines && options.maxBufferedLines > 0
			? options.maxBufferedLines
			: defaultMaxBufferedLines

	let droppedLineCount = 0
	let nextSequence = 0
	let didFlushBufferedOutput = false
	const bufferedLines: Array<BufferedLine> = []

	function writeLine(target: OutputTarget, line: string) {
		if (filters.some((filter) => filter.test(line))) {
			return
		}

		if (options.mode === 'live') {
			getStream(target).write(`${line}\n`)
			return
		}

		if (bufferedLines.length >= maxBufferedLines) {
			bufferedLines.shift()
			droppedLineCount += 1
		}

		bufferedLines.push({
			line,
			target,
			sequence: nextSequence++,
		})
	}

	function handleExit(exit: {
		code: number | null
		signal: NodeJS.Signals | null
	}) {
		if (
			options.mode !== 'buffer-on-error' ||
			exit.signal ||
			exit.code == null ||
			exit.code === 0 ||
			didFlushBufferedOutput
		) {
			return
		}

		didFlushBufferedOutput = true
		stderr.write(
			`Buffered output from ${options.label} (exit code ${exit.code}):\n`,
		)

		if (droppedLineCount > 0) {
			stderr.write(
				`[${options.label}] Omitted ${droppedLineCount} earlier buffered lines.\n`,
			)
		}

		for (const entry of bufferedLines.toSorted(
			(left, right) => left.sequence - right.sequence,
		)) {
			getStream(entry.target).write(`${entry.line}\n`)
		}
	}

	function getStream(target: OutputTarget) {
		return target === 'stdout' ? stdout : stderr
	}

	return {
		writeLine,
		handleExit,
	}
}
