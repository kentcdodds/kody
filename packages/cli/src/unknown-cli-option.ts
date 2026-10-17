/**
 * parseArgs is `strict: false` so a positional module string stays valid.
 * Unknown `--flags` must still fail: Node treats them as booleans and the
 * following path becomes the execute module source (`--code-file /tmp/m.js`
 * evaluates `/tmp/m.js` as ESM, which Workerd parses as a regex).
 *
 * String options also consume the next token even when it looks like a flag
 * (`--file --code-file` sets file to `--code-file`). Reject that unless the
 * value was inline (`--file=--code-file`).
 */

const flagShapedValue = /^--[A-Za-z][\w-]*$/

type CliOptionToken = {
	kind: string
	name?: string
	rawName?: string
	value?: string
	inlineValue?: boolean
}

export function suggestKnownCliOption(
	rawName: string,
	knownOptions: ReadonlyArray<string>,
): string | null {
	const raw = rawName.replace(/^--/, '').replace(/^-/, '')
	const suffixHit = knownOptions
		.filter((name) => raw === name || raw.endsWith(`-${name}`))
		.sort((left, right) => right.length - left.length)[0]
	return suffixHit === undefined ? null : `--${suffixHit}`
}

export function unknownCliOptionError(
	rawName: string,
	knownOptions: ReadonlyArray<string>,
): Error {
	const suggestion = suggestKnownCliOption(rawName, knownOptions)
	return new Error(
		suggestion
			? `Unknown option ${JSON.stringify(rawName)}. Did you mean ${suggestion}?`
			: `Unknown option ${JSON.stringify(rawName)}. Run \`kody --help\` for usage.`,
	)
}

export function assertNoUnknownCliOptions(
	tokens: ReadonlyArray<CliOptionToken>,
	knownOptionNames: ReadonlyArray<string>,
): void {
	const knownOptions = new Set(knownOptionNames)
	for (const token of tokens) {
		if (token.kind !== 'option' || token.name === undefined) continue
		if (!knownOptions.has(token.name)) {
			throw unknownCliOptionError(
				token.rawName ?? `--${token.name}`,
				knownOptionNames,
			)
		}
		if (
			token.inlineValue !== true &&
			typeof token.value === 'string' &&
			flagShapedValue.test(token.value)
		) {
			throw unknownCliOptionError(token.value, knownOptionNames)
		}
	}
}
