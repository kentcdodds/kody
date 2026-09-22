import { expect, test } from 'vitest'
import { runCpythonExecute } from '../../../../../tools/python-execute-eval/cpython-runner.mjs'

test('local CPython execute calls capabilities, refuses missing libraries, and reports cpu time', async () => {
	const notes = new Map<string, string>()
	const crud = await runCpythonExecute({
		source: `async def main(params):
    for op in params["ops"]:
        if op["op"] == "write":
            await kody.call("notes.write", {"id": op["id"], "text": op["text"]})
        elif op["op"] == "remove":
            await kody.call("notes.remove", {"id": op["id"]})
    listed = await kody.call("notes.list", {})
    return listed
`,
		params: {
			ops: [
				{ op: 'write', id: 'a', text: 'hello' },
				{ op: 'write', id: 'b', text: 'world' },
				{ op: 'remove', id: 'a' },
			],
		},
		async call(name: string, args: Record<string, unknown>) {
			if (name === 'notes.write') {
				notes.set(String(args.id), String(args.text))
				return { id: args.id }
			}
			if (name === 'notes.remove') {
				notes.delete(String(args.id))
				return { removed: true }
			}
			if (name === 'notes.list') {
				return {
					notes: [...notes.entries()]
						.sort(([left], [right]) => left.localeCompare(right))
						.map(([id, text]) => ({ id, text })),
				}
			}
			throw new Error(`Unknown capability: ${name}`)
		},
	})
	expect(crud.ok).toBe(true)
	expect(crud.result).toEqual({ notes: [{ id: 'b', text: 'world' }] })
	expect(crud.taxonomy).toBeNull()
	expect(crud.cpuMs).toEqual(expect.any(Number))
	expect(crud.elapsedMs).toBeGreaterThanOrEqual(0)

	const stats = await runCpythonExecute({
		source: `import statistics

def main(params):
    values = params["values"]
    return {
        "mean": round(statistics.mean(values), 6),
        "median": round(statistics.median(values), 6),
        "pstdev": round(statistics.pstdev(values), 6),
    }
`,
		params: { values: [1, 2, 3, 4, 5, 100] },
		async call() {
			throw new Error('stats task has no capability calls')
		},
	})
	expect(stats.result).toEqual({
		mean: 19.166667,
		median: 3.5,
		pstdev: 36.172811,
	})

	const numpy = await runCpythonExecute({
		source: `import numpy as np

def main(params):
    return {"mean": float(np.mean(params["values"]))}
`,
		params: { values: [1, 2, 3] },
		async call() {
			return null
		},
	})
	expect(numpy.ok).toBe(false)
	expect(numpy.taxonomy).toBe('missing_lib')

	const blocked = await runCpythonExecute({
		source: `import os

def main(params):
    return {"cwd": os.getcwd()}
`,
		params: {},
		async call() {
			return null
		},
	})
	expect(blocked.taxonomy).toBe('missing_lib')
	expect(blocked.error).toContain('blocked module: os')

	const syntax = await runCpythonExecute({
		source: 'def main(params)\n    return params\n',
		params: {},
		async call() {
			return null
		},
	})
	expect(syntax.taxonomy).toBe('syntax')

	const contract = await runCpythonExecute({
		source: 'value = 1\n',
		params: {},
		async call() {
			return null
		},
	})
	expect(contract.taxonomy).toBe('contract')
})
