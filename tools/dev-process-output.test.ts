import { Writable } from 'node:stream'
import { expect, test } from 'vitest'
import { createProcessOutputController } from './dev-process-output.ts'

function createWritableCapture() {
	const chunks: Array<string> = []
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(String(chunk))
			callback()
		},
	})

	return {
		stream,
		read() {
			return chunks.join('')
		},
	}
}

test('live mode writes lines immediately', () => {
	const stdout = createWritableCapture()
	const stderr = createWritableCapture()
	const controller = createProcessOutputController({
		label: 'dev:worker',
		mode: 'live',
		stdout: stdout.stream,
		stderr: stderr.stream,
	})

	controller.writeLine('stdout', 'worker ready')
	controller.writeLine('stderr', 'worker warning')
	controller.handleExit({ code: 0, signal: null })

	expect(stdout.read()).toBe('worker ready\n')
	expect(stderr.read()).toBe('worker warning\n')
})

test('buffer-on-error mode suppresses successful output', () => {
	const stdout = createWritableCapture()
	const stderr = createWritableCapture()
	const controller = createProcessOutputController({
		label: 'dev:mock-ai',
		mode: 'buffer-on-error',
		stdout: stdout.stream,
		stderr: stderr.stream,
	})

	controller.writeLine('stdout', 'booting')
	controller.writeLine('stderr', 'still booting')
	controller.handleExit({ code: 0, signal: null })

	expect(stdout.read()).toBe('')
	expect(stderr.read()).toBe('')
})

test('buffer-on-error mode flushes buffered stdout and stderr on failure', () => {
	const stdout = createWritableCapture()
	const stderr = createWritableCapture()
	const controller = createProcessOutputController({
		label: 'dev:mock-github',
		mode: 'buffer-on-error',
		stdout: stdout.stream,
		stderr: stderr.stream,
	})

	controller.writeLine('stdout', 'first line')
	controller.writeLine('stderr', 'second line')
	controller.handleExit({ code: 1, signal: null })

	expect(stdout.read()).toBe('first line\n')
	expect(stderr.read()).toBe(
		'Buffered output from dev:mock-github (exit code 1):\nsecond line\n',
	)
})

test('buffer-on-error mode reports truncated buffered lines', () => {
	const stdout = createWritableCapture()
	const stderr = createWritableCapture()
	const controller = createProcessOutputController({
		label: 'dev:mock-resend',
		mode: 'buffer-on-error',
		stdout: stdout.stream,
		stderr: stderr.stream,
		maxBufferedLines: 2,
	})

	controller.writeLine('stdout', 'line one')
	controller.writeLine('stderr', 'line two')
	controller.writeLine('stdout', 'line three')
	controller.handleExit({ code: 1, signal: null })

	expect(stdout.read()).toBe('line three\n')
	expect(stderr.read()).toBe(
		'Buffered output from dev:mock-resend (exit code 1):\n[dev:mock-resend] Omitted 1 earlier buffered lines.\nline two\n',
	)
})
