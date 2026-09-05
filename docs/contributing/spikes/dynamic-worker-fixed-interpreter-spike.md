# Spike: can a fixed Dynamic Worker cut Kody's unique-worker bill?

Question under test (from a suggestion by Rhys Sullivan pointing at OpenCode's
`@opencode-ai/codemode`): can Kody keep agent-generated `execute` code inside
Dynamic Workers but stop paying Cloudflare's **unique Dynamic Worker** fee for
every distinct module, by loading one stable worker and treating the generated
code as input?

Kent's hunch going in: no — code as input to a fixed worker cannot produce
non-unique billing.

## Verdict

**Both halves of the hunch are worth separating.**

- **Billing semantics: the hunch is wrong.** Cloudflare bills a Dynamic Worker
  as unique by **Worker ID + `WorkerCode`** (modules, env, outbound, compat).
  Request and RPC arguments are not part of that key. A fixed worker that
  receives code as an RPC argument is one billable worker per day, no matter how
  many distinct programs it runs.
- **Mechanism: the hunch is right for V8.** Inside a Dynamic Worker every
  string-to-code door is closed: `eval`, `new Function`, indirect eval,
  `import()` of `data:`/`blob:`/`https:` specifiers, and
  `WebAssembly.compile`/`Module`/`instantiate` from bytes all throw. And
  `LOADER.get(id, cb)` caches by ID and ignores new code returned for the same
  ID. So V8 can only run code that is part of `WorkerCode`, and `WorkerCode` is
  the billing key. There is no free lunch on the current runtime.
- **The loophole is an interpreter.** The only way to run input-code inside a
  fixed worker is to ship a JavaScript interpreter as the fixed code. That is
  exactly what OpenCode's codemode is (an acorn tree-walker over a JS subset). A
  QuickJS-in-wasm build proves the shape works locally: one fixed ID, one fixed
  ~600 KB `WorkerCode`, arbitrary programs arriving per call, async `kody.*`
  calls bridged back to the host by RPC.

So: **HELPS, conditionally.** It can collapse unique-worker cost from "one per
distinct program per user per day" to "one per user per day", but only for
programs that fit inside an interpreter — which is a different, smaller runtime
than the V8 isolate `execute` offers today (no npm imports, no `node:` builtins,
no ambient `fetch`, roughly 10× slower CPU). It is a two-tier design, not a
drop-in replacement. Whether it pays depends on a number Kody does not yet
record: the share of `execute` modules that are pure orchestration glue.

## 1. How `execute` creates Dynamic Workers today

Kody uses the Worker Loader binding, not Workers for Platforms dispatch
namespaces. Every worker that can evaluate untrusted code declares two loaders:

- `packages/worker/wrangler.jsonc`, `packages/platform-worker/wrangler.jsonc`,
  `packages/runtime-worker/wrangler.jsonc`:
  `worker_loaders: [{ binding: "LOADER" }, { binding: "APP_LOADER" }]`.
- `packages/jobs-worker` has none; jobs run through the origin `JobsHost`.

The execute path is `packages/worker/src/mcp/executor.ts`
(`createStableDynamicWorkerExecutor`):

1. Build `workerOptions` = compat options + `mainModule: 'executor.js'` + the
   hydrated module graph (agent code, bundled npm deps, virtual `kody:runtime`)
   - `globalOutbound: ctx.exports.KodyFetchGateway({ props })`. No parent `env`
     is passed into the sandbox.
2. `createStableDynamicWorkerId` hashes
   `{ version: 4, binding, appCommitSha, gatewayProps, timeoutMs, compatibilityDate, compatibilityFlags, mainModule, modules }`
   into `kody-<sha256>`. If there is no `userId`, no `APP_COMMIT_SHA`, or a
   module is not deterministically hashable, it falls back to `kody-<uuid>`.
3. `recordUniqueDynamicWorkerDay` claims a `dynamic_worker_day` meter event for
   that id (Kody's in-house proxy for the Cloudflare bill unit; see
   `docs/contributing/architecture/usage-metering.md`).
4. `input.loader.get(workerId, () => workerOptions).getEntrypoint()` then
   `entrypoint.evaluate(dispatchers)` — the per-call tool implementations are
   `@cloudflare/codemode` `ToolDispatcher` RPC stubs, so the isolate contains
   code and no authority.

Consequences for the bill:

- Identical code from the same user on the same deploy → one worker id → one
  billable worker per day. Kody already gets this reuse.
- Any change to the module text, the user, the timeout, or a deploy
  (`appCommitSha`) → new id → new billable worker.
- Agent-authored `execute` code is almost always novel, so the practical rate is
  ≈ one unique worker per `execute` call.

Package apps use the same idea with `APP_LOADER`
(`packages/worker/src/package-runtime/package-app.ts`,
`createPackageAppWorkerId`), keyed on user + package + commit + caller identity.

## 2. What Cloudflare bills as a unique Dynamic Worker

Source:
[Dynamic Workers pricing](https://developers.cloudflare.com/dynamic-workers/pricing/)
(last updated 2026-06-11) and the
[API reference](https://developers.cloudflare.com/dynamic-workers/api-reference/).

| Dimension                                             | Included               | Additional                        |
| ----------------------------------------------------- | ---------------------- | --------------------------------- |
| Dynamic Workers created daily                         | 1,000 unique per month | $0.002 per Dynamic Worker per day |
| Requests (each `fetch()` or RPC call into the worker) | Workers Standard       | $0.30 / million                   |
| CPU time (startup **and** execution)                  | Workers Standard       | $0.02 / million CPU-ms            |

The uniqueness rule, quoted:

> You are billed for each unique Dynamic Worker created in a day. A Dynamic
> Worker is uniquely identified by its **Worker ID** and **code** — if either
> changes, it counts as a new Dynamic Worker. The count resets daily.

| Scenario                                   | Counted as         |
| ------------------------------------------ | ------------------ |
| Same code, same ID, invoked multiple times | 1 Dynamic Worker   |
| Same code, different IDs                   | 1 per ID           |
| Same ID, different code versions           | 1 per code version |
| No ID or `.load(code)`                     | 1 per invocation   |

"Code" is the `WorkerCode` object returned by the `get()` callback:
`mainModule`, `modules`, `compatibilityDate/Flags`, `env`, `globalOutbound`,
`tails`. The API reference is explicit that the callback must return identical
content for the same ID, and that a random ID is the right choice when code
differs every time. `env` is serialized into the worker at load time, so it
cannot carry per-run code either.

Two practical readings:

- The unique fee is **not** an isolate cold-start fee. It is a distinct
  `(id, code)` count per UTC day. Warm reuse saves latency and CPU; it does not
  change the count.
- $0.002 is the price of **100 CPU-seconds** at Standard rates. For a trivial
  one-off module the unique fee dwarfs everything else Cloudflare bills for the
  run.

Ground truth for the account lives in the dashboard (Workers & Pages → Overview)
or GraphQL
`workersInvocationsByOwnerAndScriptGroups { uniq { distinctDynamicWorkerCount } }`.
This spike ran without Cloudflare credentials, so it did not query it; the
in-house `dynamic_worker_day` meter counts the same thing per user.

## 3. Experiment

A throwaway Wrangler project in `/tmp` with one `worker_loaders` binding,
`compatibility_date: 2026-04-16`, `nodejs_compat`, local `workerd`
(`wrangler dev --local`, wrangler 4.129.0). The full source is in the appendix.

### T1 — can a Dynamic Worker turn a string into code?

All nine attempts fail inside the dynamic worker:

```json
{
	"eval": "EvalError: Code generation from strings disallowed for this context",
	"new Function": "EvalError: Code generation from strings disallowed for this context",
	"indirect eval": "EvalError: Code generation from strings disallowed for this context",
	"import(data: url)": "Error: No such module \"data:text/javascript,export default 42\".",
	"import(blob: url)": "Error: URL.createObjectURL() is not implemented",
	"import(https:)": "Error: No such module \"https:/example.com/mod.js\".",
	"WebAssembly.compile(bytes)": "CompileError: Wasm code generation disallowed by embedder",
	"new WebAssembly.Module(bytes)": "CompileError: Wasm code generation disallowed by embedder",
	"WebAssembly.instantiate(bytes)": "CompileError: Wasm code generation disallowed by embedder"
}
```

This is the mechanical reason the "code as input" idea cannot ride on V8. The
only code V8 will run is what arrived in `WorkerCode.modules`.

### T2 — does a fixed ID with changing code pick up the new code?

`LOADER.get('t2-stale-run1', cb)` called three times with `cb` returning version
`A`, then `B`, then `C`:

```json
{
	"returned": { "first": "A", "second": "A", "third": "A" },
	"callbackCalls": 1
}
```

The loader keys on the ID and calls the code callback once. Reusing an ID for
different code does not reduce cost; it serves stale code. This matches the API
reference and Kody's existing hash-the-code design.

### T3 — local warm vs cold baseline

20 calls each, trivial module, wall-clock ms in local workerd (indicative only;
production isolate scheduling differs and Kent's measured production numbers for
warm identical-code reuse are ~60–100 ms end-to-end):

| Path                                              | first | median | p90 | max |
| ------------------------------------------------- | ----- | ------ | --- | --- |
| unique ID + unique code (today's typical execute) | 4     | 4      | 9   | 10  |
| stable ID + same code (warm reuse)                | 5     | 0      | 3   | 5   |

### T4 — a fixed worker that runs input code (QuickJS in wasm)

Fixed `WorkerCode`: a 94 KB esbuild bundle of `quickjs-emscripten-core` +
`@jitl/quickjs-wasmfile-release-sync` glue (built with `--conditions=workerd`)
and the 503 KB QuickJS wasm passed as a `{ wasm: ArrayBuffer }` module. Fixed ID
`t4-fixed-quickjs-interpreter-v1`. `globalOutbound: null`. Per call the parent
invokes `stub.run(source, dispatcher)` where `dispatcher` is a `ctx.exports`
loopback `WorkerEntrypoint` standing in for Kody's `ToolDispatcher`. The worker
creates a fresh QuickJS runtime + context per run (32 MB memory limit, 5 s
interrupt deadline), installs a `kody` proxy whose calls return QuickJS promises
settled from the RPC result, evaluates `(async () => { <source> })()`, and
drives `executePendingJobs` until the top-level promise settles.

Program (different comment appended each run so the source text is unique):

```js
const a = await kody.add({ a: 20, b: 22 })
const e = await kody.echo({ hi: 'there' })
return { a, e, sum: [1, 2, 3].map((x) => x * 2).reduce((s, x) => s + x, 0) }
```

Five runs, same fixed worker:

| run | value                        | instantiateMs (once per isolate) | evalMs | totalMs |
| --- | ---------------------------- | -------------------------------- | ------ | ------- |
| 1   | `{ a: 42, e: {…}, sum: 12 }` | 3                                | 19     | 31      |
| 2   | same                         | 3                                | 10     | 13      |
| 3   | same                         | 3                                | 8      | 9       |
| 4   | same                         | 3                                | 7      | 10      |
| 5   | same                         | 3                                | 10     | 14      |

A second, unrelated program (`return [1,2,3].map(x=>x*2)`) ran on the same fixed
worker id at 0–5 ms eval. By Cloudflare's table this is **one** billable Dynamic
Worker per day regardless of program count, because neither the ID nor the
`WorkerCode` changed. Async host calls work without the asyncify build.

### T5 — CPU cost of interpreting vs V8

Same compute-heavy program (2M-iteration modular loop + 16k map updates) on both
paths, 3 runs each:

| Path                                       | evalMs      |
| ------------------------------------------ | ----------- |
| QuickJS in fixed worker                    | 173, 82, 78 |
| V8 in a fresh unique worker (today's path) | 8, 7, 7     |

Interpretation is ~10× slower for arithmetic-heavy code and roughly at parity
for trivial glue. At
$0.02 per million CPU-ms, an extra 80 CPU-ms costs
$0.0000016 — about 1/1,250 of
the $0.002 unique fee it avoids. The CPU trade-off is economically irrelevant;
the runtime trade-off is not.

## 4. What Kody would give up on the interpreter tier

Kody's `execute` is a full Workers isolate. The interpreter tier is not.

| `execute` feature today                                                           | QuickJS fixed worker                                                                                              | OpenCode codemode (acorn tree-walker)                                            |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Real ES2023 (classes, generators, `.then`, `new Promise`)                         | Yes                                                                                                               | No — documented "orchestration language" subset                                  |
| Bare npm imports bundled by Kody (`p-retry`, `mailparser`, `googleapis`, …)       | Only if fed through a QuickJS module loader **and** the package avoids `node:`/Web APIs; most real packages break | No modules at all                                                                |
| `kody:@scope/pkg` static imports (inlined in the same isolate, zero extra worker) | Same caveat as npm                                                                                                | No                                                                               |
| `node:` builtins, `nodejs_compat`                                                 | No                                                                                                                | No                                                                               |
| Ambient `fetch` with `{{secret:…}}` placeholder expansion via `KodyFetchGateway`  | Must become a host tool (`kody.fetch`-style RPC with serialized Request/Response)                                 | Same                                                                             |
| Web platform globals (`URL`, `TextEncoder`, `crypto.subtle`, streams)             | Partial (`URL`, JSON, Math, Date, RegExp); no `crypto.subtle`, no streams                                         | Partial                                                                          |
| CPU                                                                               | ~10× slower on compute                                                                                            | Slower still (tree-walking)                                                      |
| Isolation                                                                         | Fresh QuickJS runtime per run inside a per-user isolate; memory + deadline limits enforced by QuickJS             | Interpreter-enforced                                                             |
| Dependencies to ship                                                              | ~0.6 MB (glue + wasm)                                                                                             | `effect` + `acorn` + `typescript` (transpile step) — heavy; API is Effect-native |

Porting `@opencode-ai/codemode` wholesale is a poor fit: it is private, Effect-
native, and built for a bounded tool-orchestration language. QuickJS gives the
same billing property with real JavaScript semantics at a fraction of the
integration surface, which is why the spike used it.

## 5. Estimated reduction and how to size it

Let, per UTC day:

- `N` = distinct `(user, module text, deploy)` execute workers (today's
  `dynamic_worker_day` count),
- `q` = share of those modules that are interpretable (no imports beyond
  `kody:runtime`, no `fetch`, no `node:`/Web APIs, tolerant of ~10× CPU),
- `U` = active execute users.

Unique-worker cost moves from `0.002 × N` to `0.002 × ((1 − q) × N + U)` — the
interpreter tier costs at most one worker per user per day (plus one per deploy
that day, since the fixed worker's id should still include `appCommitSha` so
interpreter upgrades take effect). Sharing a single interpreter worker across
all users would take it to `+1` instead of `+U`, but puts concurrent users'
in-flight data in one isolate behind wasm memory safety; per-user is the
conservative match for today's isolation boundary.

Kody does not record `q`. The cheapest sizing step is a classifier at bundle
time (module graph has only the entry + virtual `kody:runtime`; no `fetch`
identifier; no `node:` specifier) emitted as a usage-event field, run for a
week, and read from the same admin insights that already show
`dynamic_worker_day`. If `q` is under ~30% the redesign is not worth its runtime
split; if most agent modules are glue over `kody.*`, the saving approaches
`0.002 × (N − U)` per day.

For scale: 1,000 unique workers/day is $2/day ≈ $60/month above the included
1,000/month; the interpreter tier at 100 users is $0.20/day for the same
traffic.

## 6. Recommendation

1. **Reply to Rhys**: the billing angle is real — Cloudflare keys uniqueness on
   ID + `WorkerCode`, not on inputs — but it only becomes reachable by putting a
   JS interpreter inside the fixed worker, because V8 in a Dynamic Worker will
   not evaluate strings. That is why codemode is an interpreter. For Kody it
   means a second, smaller runtime tier (QuickJS or a tree-walker) for glue-only
   programs, with the V8 unique-worker path kept for anything that imports npm
   packages, uses `fetch`, or needs Node compat.
2. **Do not adopt yet.** First measure `q` (one bundle-time classifier field, no
   runtime change). The redesign is only worth it if a large share of execute
   traffic is pure orchestration.
3. **If `q` is high**, the production shape is: a `FixedInterpreter`
   `WorkerEntrypoint` module + wasm added to the executor's fixed modules, keyed
   `kody-interp-<hash(userId, gatewayProps, appCommitSha, interpreter version)>`;
   `run(source, dispatchers)` replacing `evaluate(dispatchers)`;
   `globalOutbound: null`; a host `fetch` tool for the interpreter tier; and a
   bundle-time router that falls back to the current V8 path when the classifier
   says no. The `dynamic_worker_day` meter needs no change — it already counts
   ids.
4. **Separately raise with Cloudflare** the thing that would make all of this
   moot: pricing warm reuse of a stable _loader_ whose only variation is a
   `{ text: … }` module, or an `evaluate`-style API that treats a module string
   as request input. Their own pricing table shows why that is not how it works
   today.

## 7. What remains unverified

- Production billing was not observed. The account-level
  `distinctDynamicWorkerCount` GraphQL field (or the dashboard) is the ground
  truth; this spike had no Cloudflare credentials. Cheapest next proof: run the
  T4 worker in a preview deploy for one UTC day with a few hundred distinct
  programs and confirm the count increments by one.
- Whether different `ctx.props` on `globalOutbound`/`env` stubs count as
  different "code". Kody already puts `gatewayProps` in the id hash, so the
  answer does not change Kody's count either way.
- Production cold-start for a ~600 KB fixed worker (wasm compile happens at
  load; local instantiate was 2–3 ms). Startup CPU is billed on Dynamic Workers,
  so this should be measured once before shipping.

## Appendix — spike source

Reproduce in an empty directory with
`npm i wrangler@4.129.0 quickjs-emscripten-core @jitl/quickjs-wasmfile-release-sync esbuild`,
then:

```sh
npx esbuild src/dw-quickjs-entry.js --bundle --format=esm --platform=browser \
  --conditions=workerd --external:cloudflare:workers --external:./quickjs.wasm \
  --outfile=dist/dw-quickjs.js.txt
cp node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm dist/quickjs.wasm.bin
npx wrangler dev --port 8799 --local
curl localhost:8799/t1-eval
curl 'localhost:8799/t2-stale?id=run1'
curl 'localhost:8799/t3-timing?n=20'
curl 'localhost:8799/t4-quickjs?runs=5'
curl --get --data-urlencode 'code=return 1' --data-urlencode runs=3 localhost:8799/t5-v8
```

`wrangler.jsonc`:

```jsonc
{
	"name": "dw-spike",
	"main": "src/index.ts",
	"compatibility_date": "2026-04-16",
	"compatibility_flags": ["nodejs_compat"],
	"worker_loaders": [{ "binding": "LOADER" }],
	"rules": [
		{ "type": "Text", "globs": ["**/*.txt"], "fallthrough": true },
		{ "type": "Data", "globs": ["**/*.bin"], "fallthrough": true },
	],
}
```

`src/dw-quickjs-entry.js` (the fixed dynamic worker):

```js
import { WorkerEntrypoint } from 'cloudflare:workers'
import {
	newQuickJSWASMModuleFromVariant,
	newVariant,
	shouldInterruptAfterDeadline,
	Scope,
} from 'quickjs-emscripten-core'
import baseVariant from '@jitl/quickjs-wasmfile-release-sync'
import wasmModule from './quickjs.wasm'

let quickjsPromise = null
let instantiateMs = null

function getQuickJs() {
	if (!quickjsPromise) {
		const started = performance.now()
		quickjsPromise = newQuickJSWASMModuleFromVariant(
			newVariant(baseVariant, { wasmModule }),
		).then((mod) => {
			instantiateMs = performance.now() - started
			return mod
		})
	}
	return quickjsPromise
}

export default class FixedInterpreter extends WorkerEntrypoint {
	async run(source, dispatcher) {
		const QuickJS = await getQuickJs()
		const evalStarted = performance.now()
		return Scope.withScopeAsync(async (scope) => {
			const runtime = scope.manage(QuickJS.newRuntime())
			runtime.setMemoryLimit(32 * 1024 * 1024)
			runtime.setInterruptHandler(
				shouldInterruptAfterDeadline(Date.now() + 5000),
			)
			const vm = scope.manage(runtime.newContext())
			const pending = []

			// Host function returns a QuickJS promise settled from the RPC result.
			const call = scope.manage(
				vm.newFunction('call', (nameHandle, argsHandle) => {
					const name = vm.getString(nameHandle)
					const args = vm.dump(argsHandle)
					const deferred = scope.manage(vm.newPromise())
					pending.push(
						dispatcher
							.call(name, JSON.stringify(args ?? {}))
							.then((json) => {
								const value = vm.unwrapResult(vm.evalCode(`(${json})`))
								deferred.resolve(value)
								value.dispose()
							})
							.catch((error) => {
								const err = vm.newError(String(error?.message ?? error))
								deferred.reject(err)
								err.dispose()
							}),
					)
					return deferred.handle
				}),
			)
			vm.setProp(vm.global, '__kodyCall', call)
			vm.unwrapResult(
				vm.evalCode(
					`globalThis.kody = new Proxy({}, { get: (_, name) => (args) => __kodyCall(String(name), args ?? {}) });`,
				),
			).dispose()

			const resultHandle = scope.manage(
				vm.unwrapResult(vm.evalCode(`(async () => {\n${source}\n})()`)),
			)
			let state = vm.getPromiseState(resultHandle)
			while (state.type === 'pending') {
				runtime.executePendingJobs()
				state = vm.getPromiseState(resultHandle)
				if (state.type !== 'pending') break
				if (pending.length === 0) await new Promise((r) => setTimeout(r, 0))
				else await Promise.race(pending.splice(0))
				runtime.executePendingJobs()
				state = vm.getPromiseState(resultHandle)
			}
			if (state.type === 'rejected') {
				const err = vm.dump(scope.manage(state.error))
				throw new Error(`QuickJS program rejected: ${JSON.stringify(err)}`)
			}
			return {
				value: vm.dump(scope.manage(state.value)),
				instantiateMs,
				evalMs: performance.now() - evalStarted,
			}
		})
	}
}
```

`src/index.ts` (parent worker; T1–T5):

```ts
import { WorkerEntrypoint } from 'cloudflare:workers'
import quickjsBundle from '../dist/dw-quickjs.js.txt'
import quickjsWasm from '../dist/quickjs.wasm.bin'

type Env = { LOADER: WorkerLoader }
const compat = {
	compatibilityDate: '2026-04-16',
	compatibilityFlags: ['nodejs_compat'],
}

export class Dispatcher extends WorkerEntrypoint {
	async call(name: string, argsJson: string) {
		const args = JSON.parse(argsJson)
		if (name === 'echo') return JSON.stringify({ echoed: args, at: Date.now() })
		if (name === 'add') return JSON.stringify(args.a + args.b)
		throw new Error(`unknown tool ${name}`)
	}
}

const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value, null, 2), {
		status,
		headers: { 'content-type': 'application/json' },
	})

const evalProbeSource = `
import { WorkerEntrypoint } from 'cloudflare:workers'
export default class Probe extends WorkerEntrypoint {
  async probe(wasmBytes) {
    const results = {}
    const attempt = async (name, fn) => {
      try { results[name] = { ok: true, value: String(await fn()) } }
      catch (e) { results[name] = { ok: false, error: e?.constructor?.name + ': ' + (e?.message ?? String(e)) } }
    }
    await attempt('eval', () => eval('1 + 1'))
    await attempt('new Function', () => new Function('return 2 + 2')())
    await attempt('indirect eval', () => (0, eval)('3 + 3'))
    await attempt('import(data: url)', () => import('data:text/javascript,export default 42').then(m => m.default))
    await attempt('import(blob: url)', () => import(URL.createObjectURL(new Blob(['export default 43'], { type: 'text/javascript' }))).then(m => m.default))
    await attempt('import(https:)', () => import('https://example.com/mod.js').then(m => m.default))
    await attempt('WebAssembly.compile(bytes)', async () => (await WebAssembly.compile(wasmBytes)).constructor.name)
    await attempt('new WebAssembly.Module(bytes)', () => new WebAssembly.Module(wasmBytes).constructor.name)
    await attempt('WebAssembly.instantiate(bytes)', async () => (await WebAssembly.instantiate(wasmBytes)).constructor.name)
    return results
  }
}
`
const emptyWasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer
const versionedSource = (version: string) => `
import { WorkerEntrypoint } from 'cloudflare:workers'
export default class V extends WorkerEntrypoint { version() { return ${JSON.stringify(version)} } }
`

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url)
		try {
			if (url.pathname === '/t1-eval') {
				const stub = env.LOADER.get('t1-eval-probe', () => ({
					...compat,
					mainModule: 'probe.js',
					modules: { 'probe.js': evalProbeSource },
					globalOutbound: null,
				}))
				return json(await (stub.getEntrypoint() as any).probe(emptyWasm))
			}
			if (url.pathname === '/t2-stale') {
				const id = `t2-stale-${url.searchParams.get('id') ?? 'fixed'}`
				let callbackCalls = 0
				const load = (version: string) =>
					env.LOADER.get(id, () => {
						callbackCalls++
						return {
							...compat,
							mainModule: 'v.js',
							modules: { 'v.js': versionedSource(version) },
							globalOutbound: null,
						}
					})
				const first = await (load('A').getEntrypoint() as any).version()
				const second = await (load('B').getEntrypoint() as any).version()
				const third = await (load('C').getEntrypoint() as any).version()
				return json({ id, returned: { first, second, third }, callbackCalls })
			}
			if (url.pathname === '/t3-timing') {
				const n = Number(url.searchParams.get('n') ?? 20)
				const timings: Record<string, number[]> = {
					uniqueIdUniqueCode: [],
					stableIdSameCode: [],
				}
				for (let i = 0; i < n; i++) {
					const started = performance.now()
					const stub = env.LOADER.get(
						`t3-unique-${crypto.randomUUID()}`,
						() => ({
							...compat,
							mainModule: 'v.js',
							modules: {
								'v.js': versionedSource(`unique-${i}-${Math.random()}`),
							},
							globalOutbound: null,
						}),
					)
					await (stub.getEntrypoint() as any).version()
					timings.uniqueIdUniqueCode.push(performance.now() - started)
				}
				for (let i = 0; i < n; i++) {
					const started = performance.now()
					const stub = env.LOADER.get('t3-stable', () => ({
						...compat,
						mainModule: 'v.js',
						modules: { 'v.js': versionedSource('stable') },
						globalOutbound: null,
					}))
					await (stub.getEntrypoint() as any).version()
					timings.stableIdSameCode.push(performance.now() - started)
				}
				const summarize = (xs: number[]) => {
					const sorted = [...xs].sort((a, b) => a - b)
					return {
						n: xs.length,
						first: Number(xs[0]?.toFixed(2)),
						median: Number(sorted[Math.floor(sorted.length / 2)]?.toFixed(2)),
						p90: Number(sorted[Math.floor(sorted.length * 0.9)]?.toFixed(2)),
						max: Number(sorted.at(-1)?.toFixed(2)),
					}
				}
				return json({
					uniqueIdUniqueCode: summarize(timings.uniqueIdUniqueCode),
					stableIdSameCode: summarize(timings.stableIdSameCode),
				})
			}
			if (url.pathname === '/t4-quickjs') {
				const source =
					url.searchParams.get('code') ??
					`const a = await kody.add({ a: 20, b: 22 }); const e = await kody.echo({ hi: 'there' }); return { a, e, sum: [1,2,3].map(x => x * 2).reduce((s, x) => s + x, 0) }`
				const runs = Number(url.searchParams.get('runs') ?? 1)
				const results: unknown[] = []
				for (let i = 0; i < runs; i++) {
					const started = performance.now()
					// The ID and code are FIXED regardless of `source`.
					const stub = env.LOADER.get(
						't4-fixed-quickjs-interpreter-v1',
						() => ({
							...compat,
							mainModule: 'dw-quickjs.js',
							modules: {
								'dw-quickjs.js': quickjsBundle,
								'quickjs.wasm': { wasm: quickjsWasm },
							},
							globalOutbound: null,
						}),
					)
					const dispatcher = ctx.exports.Dispatcher({ props: { run: i } })
					const result = await (stub.getEntrypoint() as any).run(
						`${source}\n// run ${i} ${Math.random()}`,
						dispatcher,
					)
					results.push({ ...result, totalMs: performance.now() - started })
				}
				return json({
					fixedWorkerId: 't4-fixed-quickjs-interpreter-v1',
					fixedCodeBytes: quickjsBundle.length + quickjsWasm.byteLength,
					source,
					results,
				})
			}
			if (url.pathname === '/t5-v8') {
				// Today's Kody path: unique code => unique worker id => new isolate.
				const source = url.searchParams.get('code') ?? 'return 1'
				const runs = Number(url.searchParams.get('runs') ?? 1)
				const results: unknown[] = []
				for (let i = 0; i < runs; i++) {
					const started = performance.now()
					const stub = env.LOADER.get(`t5-v8-${crypto.randomUUID()}`, () => ({
						...compat,
						mainModule: 'm.js',
						modules: {
							'm.js': `import { WorkerEntrypoint } from 'cloudflare:workers'
export default class M extends WorkerEntrypoint {
  async run() { const started = performance.now(); const value = await (async () => {\n${source}\n// run ${i} ${Math.random()}\n})(); return { value, evalMs: performance.now() - started } }
}`,
						},
						globalOutbound: null,
					}))
					const result = await (stub.getEntrypoint() as any).run()
					results.push({ ...result, totalMs: performance.now() - started })
				}
				return json({ source, results })
			}
			return json({
				routes: [
					'/t1-eval',
					'/t2-stale',
					'/t3-timing',
					'/t4-quickjs',
					'/t5-v8',
				],
			})
		} catch (error) {
			return json({ error: String((error as Error)?.stack ?? error) }, 500)
		}
	},
}
```
