const vlqAlphabet =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export type AttributedSourceBytes = {
	source: string
	bytes: number
}

export type SourceByteDelta = {
	source: string
	bytes: number
	baseBytes: number
	delta: number
}

export type StartupBundleCheckArgs = {
	attribute: boolean
	base: string | null
	keepOutdir: string | null
	compareOutdir: string | null
}

export function parseStartupBundleCheckArgs(
	argv: ReadonlyArray<string>,
): StartupBundleCheckArgs {
	let attribute = false
	let base: string | null = null
	let keepOutdir: string | null = null
	let compareOutdir: string | null = null
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		switch (arg) {
			case '--attribute':
				attribute = true
				break
			case '--base': {
				base = requireArgValue(argv[index + 1], '--base')
				index += 1
				attribute = true
				break
			}
			case '--keep-outdir': {
				keepOutdir = requireArgValue(argv[index + 1], '--keep-outdir')
				index += 1
				break
			}
			case '--compare-outdir': {
				compareOutdir = requireArgValue(argv[index + 1], '--compare-outdir')
				index += 1
				attribute = true
				break
			}
			default:
				throw new Error(
					`Unknown argument: ${arg}. Expected --attribute [--base <ref-or-outdir>] [--keep-outdir <dir>] [--compare-outdir <dir>].`,
				)
		}
	}
	return { attribute, base, keepOutdir, compareOutdir }
}

function requireArgValue(value: string | undefined, flag: string) {
	if (!value || value.startsWith('-')) {
		throw new Error(`${flag} requires a value.`)
	}
	return value
}

export function normalizeAttributionSource(source: string) {
	return source
		.replaceAll('\\', '/')
		.replace(/^webpack:\/\//, '')
		.replace(/^file:\/\//, '')
}

export function attributeGeneratedBytes(
	generated: string,
	sourceMapText: string,
): Array<AttributedSourceBytes> {
	const sourceMap = JSON.parse(sourceMapText) as {
		sources?: unknown
		mappings?: unknown
	}
	if (
		!Array.isArray(sourceMap.sources) ||
		!sourceMap.sources.every((source) => typeof source === 'string') ||
		typeof sourceMap.mappings !== 'string'
	) {
		throw new Error('Source map is missing sources or mappings.')
	}
	const totals = new Map<string, number>()
	for (const source of sourceMap.sources) {
		totals.set(normalizeAttributionSource(source), 0)
	}
	const generatedLines = generated.split('\n')
	const mappingLines = sourceMap.mappings.split(';')
	let sourceIndex = 0
	let currentSourceIndex: number | null = null
	for (let lineIndex = 0; lineIndex < generatedLines.length; lineIndex += 1) {
		const line = generatedLines[lineIndex] ?? ''
		const mappingLine = mappingLines[lineIndex] ?? ''
		const newlineBytes = lineIndex < generatedLines.length - 1 ? 1 : 0
		const segments = decodeMappingLine(mappingLine)
		let generatedColumn = 0
		let cursor = 0
		for (const segment of segments) {
			generatedColumn += segment[0] ?? 0
			const start = Math.min(generatedColumn, line.length)
			if (start > cursor) {
				addBytes(
					totals,
					sourceMap.sources,
					currentSourceIndex,
					line,
					cursor,
					start,
				)
				cursor = start
			}
			if (segment.length >= 4) {
				sourceIndex += segment[1] ?? 0
				currentSourceIndex = sourceIndex
			} else {
				currentSourceIndex = null
			}
		}
		if (cursor < line.length || newlineBytes > 0) {
			addBytes(
				totals,
				sourceMap.sources,
				currentSourceIndex,
				line,
				cursor,
				line.length,
				newlineBytes,
			)
		}
	}
	return [...totals.entries()]
		.map(([source, bytes]) => ({ source, bytes }))
		.sort(
			(left, right) =>
				right.bytes - left.bytes || left.source.localeCompare(right.source),
		)
}

function addBytes(
	totals: Map<string, number>,
	sources: ReadonlyArray<string>,
	sourceIndex: number | null,
	line: string,
	start: number,
	end: number,
	extraBytes = 0,
) {
	if (sourceIndex == null) return
	const source = sources[sourceIndex]
	if (!source) return
	const key = normalizeAttributionSource(source)
	const bytes = Buffer.byteLength(line.slice(start, end), 'utf8') + extraBytes
	totals.set(key, (totals.get(key) ?? 0) + bytes)
}

function decodeMappingLine(mappingLine: string) {
	if (mappingLine.length === 0) return []
	return mappingLine.split(',').map((segment) => decodeVlq(segment))
}

function decodeVlq(segment: string) {
	const values: Array<number> = []
	let value = 0
	let shift = 0
	for (const char of segment) {
		const digit = vlqAlphabet.indexOf(char)
		if (digit < 0) {
			throw new Error(`Invalid VLQ character in source map: ${char}`)
		}
		value += (digit & 31) << shift
		if ((digit & 32) === 0) {
			const decoded = value & 1 ? -(value >> 1) : value >> 1
			values.push(decoded)
			value = 0
			shift = 0
			continue
		}
		shift += 5
	}
	return values
}

export function diffAttributedSources(
	current: ReadonlyArray<AttributedSourceBytes>,
	base: ReadonlyArray<AttributedSourceBytes>,
): Array<SourceByteDelta> {
	const currentBySource = new Map(
		current.map((entry) => [entry.source, entry.bytes]),
	)
	const baseBySource = new Map(base.map((entry) => [entry.source, entry.bytes]))
	const sources = new Set([...currentBySource.keys(), ...baseBySource.keys()])
	return [...sources]
		.map((source) => {
			const bytes = currentBySource.get(source) ?? 0
			const baseBytes = baseBySource.get(source) ?? 0
			return {
				source,
				bytes,
				baseBytes,
				delta: bytes - baseBytes,
			}
		})
		.sort(
			(left, right) =>
				Math.abs(right.delta) - Math.abs(left.delta) ||
				right.bytes - left.bytes ||
				left.source.localeCompare(right.source),
		)
}

export function formatAttributedSources(
	entries: ReadonlyArray<AttributedSourceBytes>,
	limit = 25,
) {
	return entries
		.filter((entry) => entry.bytes > 0)
		.slice(0, limit)
		.map(
			(entry) => `  ${formatCount(entry.bytes).padStart(8)}  ${entry.source}`,
		)
		.join('\n')
}

export function formatSourceByteDeltas(
	entries: ReadonlyArray<SourceByteDelta>,
	limit = 25,
) {
	return entries
		.filter((entry) => entry.delta !== 0)
		.slice(0, limit)
		.map((entry) => {
			const sign = entry.delta > 0 ? '+' : ''
			return `  ${`${sign}${formatCount(entry.delta)}`.padStart(8)}  ${entry.source}`
		})
		.join('\n')
}

function formatCount(value: number) {
	return value.toLocaleString('en-US')
}
