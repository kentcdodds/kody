/**
 * One-line prefer-local guidance shared by MCP server instructions, the
 * execute tool description, and the api tool description. Single source of
 * truth — keep the three surfaces in sync via this constant.
 *
 * How to run Kody code (local CLI vs hosted execute), not prefer-Kody-over-host
 * policy. Host-vs-Kody guidance stays in skills / guides.
 */
export const preferLocalCliExecuteGuidance =
	'When Node ≥22 and the Kody CLI are available, run code with `kody execute --local`.'
