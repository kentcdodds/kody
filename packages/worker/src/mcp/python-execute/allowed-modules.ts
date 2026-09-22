/**
 * Stdlib modules the user module may import.
 *
 * Anything else imported from `<python-execute>` raises
 * `ImportError: blocked module: <name>`, including packages that happen to
 * be installed on a developer machine (numpy). Stdlib modules on this list
 * may themselves import `os` while loading; that import is not a user import.
 * The copy in `tools/python-execute-eval/sandbox-harness.py` is locked to
 * this list by a node test.
 */
export const pythonExecuteAllowedModules = [
	'array',
	'bisect',
	'collections',
	'copy',
	'csv',
	'dataclasses',
	'datetime',
	'decimal',
	'enum',
	'fractions',
	'functools',
	'heapq',
	'io',
	'itertools',
	'json',
	'math',
	'numbers',
	'operator',
	'random',
	're',
	'statistics',
	'string',
	'textwrap',
	'typing',
] as const

export type PythonExecuteAllowedModule =
	(typeof pythonExecuteAllowedModules)[number]
