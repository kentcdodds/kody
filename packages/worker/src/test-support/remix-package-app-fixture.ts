import { build, type Plugin } from 'esbuild'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A mid-complexity Remix package app used by the MCP end-to-end test. It is
 * the shape `docs/guides/package-apps.md` documents as Example A (Remix
 * recipe), so the test proves the recipe as written — including the
 * boilerplate the host does not apply (JSX import source, remount, explicit
 * island ids).
 *
 * Remix arrives as an ordinary package dependency: package.json declares
 * `remix@3.0.0`, and the fixture plants a self-contained
 * `node_modules/remix` built from the repo install for the recipe subpaths.
 * That matches what createWorker does when `node_modules/<name>/package.json`
 * is already present (skip npm install for that name) without requiring the
 * Worker to fetch remix from the registry during the MCP e2e window.
 */

const remixPackageName = 'remix'

/** Recipe subpaths the fixture imports (and their JSX runtimes). */
const remixRecipeSubpaths = [
	'component',
	'component/jsx-dev-runtime',
	'component/jsx-runtime',
	'component/server',
	'data-schema',
	'data-schema/form-data',
	'middleware/form-data',
	'response/html',
	'response/redirect',
	'router',
	'routes',
] as const

const nodeBuiltins = new Set([
	'assert',
	'async_hooks',
	'buffer',
	'child_process',
	'crypto',
	'events',
	'fs',
	'http',
	'https',
	'inspector',
	'module',
	'net',
	'os',
	'path',
	'perf_hooks',
	'process',
	'stream',
	'tls',
	'url',
	'util',
	'worker_threads',
	'zlib',
])

const remixExternalsPlugin: Plugin = {
	name: 'remix-fixture-externals',
	setup(pluginBuild) {
		pluginBuild.onResolve({ filter: /^cloudflare:/ }, (args) => ({
			path: args.path,
			external: true,
		}))
		pluginBuild.onResolve({ filter: /^node:/ }, (args) => ({
			path: args.path,
			external: true,
		}))
		pluginBuild.onResolve({ filter: /^[a-z_]+$/ }, (args) => {
			if (!nodeBuiltins.has(args.path)) return null
			return { path: `node:${args.path}`, external: true }
		})
	},
}

type RemixExportTarget = string | { default?: string; types?: string }

let packageSuppliedRemixFilesPromise: Promise<Record<string, string>> | null =
	null

function resolveRepoRoot() {
	return path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		'../../../..',
	)
}

/**
 * Bundle the recipe's `remix/<subpath>` entries from the repo install into a
 * self-contained `node_modules/remix` package. createWorker skips npm install
 * for any dependency whose `node_modules/<name>/package.json` is already in
 * the snapshot, so planting these files is what makes the e2e publish resolve
 * remix from the package instead of the registry.
 */
export async function loadPackageSuppliedRemixFiles(): Promise<
	Record<string, string>
> {
	packageSuppliedRemixFilesPromise ??= (async () => {
		const repoRoot = resolveRepoRoot()
		const remixPackageDir = path.join(
			repoRoot,
			'node_modules',
			remixPackageName,
		)
		const remixPackage = JSON.parse(
			await readFile(path.join(remixPackageDir, 'package.json'), 'utf8'),
		) as { version: string; exports: Record<string, RemixExportTarget> }
		const entryPoints: Record<string, string> = {}
		const vendoredExports: Record<string, string> = {
			'./package.json': './package.json',
		}
		for (const subpath of remixRecipeSubpaths) {
			const target = remixPackage.exports[`./${subpath}`]
			const targetFile =
				typeof target === 'string' ? target : (target?.default ?? null)
			if (!targetFile) {
				throw new Error(
					`remix@${remixPackage.version} does not export "./${subpath}"; update remixRecipeSubpaths.`,
				)
			}
			entryPoints[`${remixPackageName}/dist/${subpath}`] = path.join(
				remixPackageDir,
				targetFile,
			)
			vendoredExports[`./${subpath}`] = `./dist/${subpath}.js`
		}
		const bundleOutdir = path.join(repoRoot, 'node_modules')
		const result = await build({
			entryPoints,
			bundle: true,
			splitting: true,
			format: 'esm',
			platform: 'neutral',
			mainFields: ['module', 'main'],
			conditions: ['workerd', 'worker', 'browser', 'import', 'default'],
			target: 'es2022',
			minify: true,
			write: false,
			outdir: bundleOutdir,
			chunkNames: 'remix/dist/chunks/[name]-[hash]',
			plugins: [remixExternalsPlugin],
			logLevel: 'silent',
		})
		const files: Record<string, string> = {
			[`node_modules/${remixPackageName}/package.json`]: JSON.stringify(
				{
					name: remixPackageName,
					version: remixPackage.version,
					type: 'module',
					exports: vendoredExports,
				},
				null,
				'\t',
			),
		}
		for (const output of result.outputFiles) {
			const relative = path
				.relative(bundleOutdir, output.path)
				.replaceAll(path.sep, '/')
			if (relative.startsWith('..')) {
				throw new Error(
					`remix fixture prebuild emitted "${output.path}" outside node_modules.`,
				)
			}
			files[`node_modules/${relative}`] = output.text
		}
		return files
	})()
	return await packageSuppliedRemixFilesPromise
}

export async function createRemixPackageAppFiles(input: {
	username: string
	kodyId: string
}): Promise<Record<string, string>> {
	const packageJson = {
		name: `@${input.username}/${input.kodyId}`,
		private: true,
		exports: { '.': './src/index.ts' },
		// Ordinary npm dependency: the platform does not supply remix.
		dependencies: { remix: '3.0.0' },
		kody: {
			id: input.kodyId,
			description:
				'Remix recipe fixture: routes, action, middleware, SSR, remount',
			app: {
				entry: './app/router.ts',
				client: './app/assets/entry.ts',
				assets: './public',
			},
		},
	}
	const authored: Record<string, string> = {
		'package.json': `${JSON.stringify(packageJson, null, '\t')}\n`,
		'tsconfig.json': `${JSON.stringify(
			{
				compilerOptions: {
					jsx: 'react-jsx',
					jsxImportSource: 'remix/component',
					allowImportingTsExtensions: true,
					strict: true,
					noEmit: true,
					module: 'esnext',
					moduleResolution: 'bundler',
					target: 'es2022',
				},
			},
			null,
			'\t',
		)}\n`,
		'README.md':
			'# Remix notes\n\n## Intent\n\nProve a package app can use Remix as a recipe: Worker fetch entry, remount, and Kody via `KodyRuntime`.\n',
		'AGENTS.md': [
			'# Agents',
			'',
			'Remix recipe. Default-export a fetch handler. The host strips the',
			'app mount; remount the Request if the route contract is prefixed.',
			'',
			'- Import Remix as `remix/<subpath>` and declare `remix` in',
			'  `package.json#dependencies` (and `@remix-run/ui` if you use primitives).',
			'  The platform does not supply frameworks.',
			'- Set `"jsxImportSource": "remix/component"` in tsconfig and/or a per-file pragma.',
			'- Routes live in `app/routes.ts`, prefixed with `packageContext.appBasePath`;',
			'  remount in `app/router.ts` so those prefixes match. Build every URL with',
			'  `routes.x.href()`, never a root-relative literal.',
			'- Controllers in `app/controllers/` read Kody through `get(KodyRuntime)`.',
			'- Islands in `app/ui/` are named `clientEntry` functions with an explicit',
			'  id (`kody:app#Name`) registered in `app/assets/entry.ts`; static files',
			'  and `sw.js` live in `public/`.',
			'',
		].join('\n'),
		'src/index.ts':
			'export default async function main() {\n\treturn { ok: true }\n}\n',
		'app/routes.ts': `import { packageContext } from 'kody:runtime'
import { form, route } from 'remix/routes'

// Hosted apps live under a mount (/packages/<id> on the subdomain). Prefixing
// the contract keeps every href(), redirect, and form action inside it.
export const routes = route(packageContext?.appBasePath ?? '', {
	home: '/',
	notes: form('notes'),
	health: '/healthz',
})
`,
		'app/router.ts': `import { packageContext } from 'kody:runtime'
import { createRouter } from 'remix/router'
import { formData } from 'remix/middleware/form-data'
import { requestId } from './middleware/request-id.ts'
import { routes } from './routes.ts'
import home from './controllers/home.tsx'
import notes from './controllers/notes.tsx'

const router = createRouter({ middleware: [requestId(), formData()] })

router.map(routes.home, home)
router.map(routes.notes, notes)
router.get(routes.health, () => Response.json({ ok: true }))

// The host strips the mount before forwarding. Remix route contracts that
// include appBasePath need the hosted pathname, so remount here.
function remountRequest(request: Request) {
	const appBasePath = String(packageContext?.appBasePath ?? '').replace(
		/\\/+$/,
		'',
	)
	if (!appBasePath) return request
	const url = new URL(request.url)
	url.pathname = url.pathname === '/' ? appBasePath : appBasePath + url.pathname
	return new Request(url, request)
}

export default {
	fetch(request: Request) {
		return router.fetch(remountRequest(request))
	},
}
`,
		'app/middleware/request-id.ts': `import { createContextKey, type Middleware } from 'remix/router'

export const RequestId = createContextKey<string>()

export function requestId(): Middleware {
	return async (context, next) => {
		context.set(RequestId, crypto.randomUUID())
		const response = await next()
		response.headers.set('x-request-id', context.get(RequestId) ?? '')
		return response
	}
}
`,
		'app/data/notes.ts': `import { KodyRuntime } from 'kody:runtime'
import type { RequestContext } from 'remix/router'

export type Note = { id: string; text: string }

const notesKey = 'notes'

export async function listNotes(context: RequestContext): Promise<Array<Note>> {
	const storage = context.get(KodyRuntime).packageStorage()
	const stored = await storage.get(notesKey)
	return Array.isArray(stored) ? (stored as Array<Note>) : []
}

export async function addNote(context: RequestContext, text: string) {
	const storage = context.get(KodyRuntime).packageStorage()
	const notes = await listNotes(context)
	const note: Note = { id: crypto.randomUUID(), text }
	await storage.set(notesKey, [...notes, note])
	return note
}
`,
		'app/controllers/home.tsx': `/** @jsxImportSource remix/component */
import type { BuildAction } from 'remix/router'
import { KodyRuntime } from 'kody:runtime'
import { listNotes } from '../data/notes.ts'
import { RequestId } from '../middleware/request-id.ts'
import { render } from '../ui/render.tsx'
import { routes } from '../routes.ts'
import { Counter } from '../ui/counter.tsx'

export default {
	async handler(context) {
		const { packageContext } = context.get(KodyRuntime)
		const notes = await listNotes(context)
		return render(
			context,
			<main>
				<h1 id="title">Remix notes</h1>
				<p id="mount">Mounted at {packageContext?.appBasePath ?? '/'}</p>
				<p id="request-id">{context.get(RequestId) ?? 'no-request-id'}</p>
				<Counter initialCount={notes.length} label="Notes" />
				<a href={routes.notes.index.href()}>Add a note</a>
			</main>,
		)
	},
} satisfies BuildAction<'ANY', typeof routes.home>
`,
		'app/controllers/notes.tsx': `/** @jsxImportSource remix/component */
import type { Controller } from 'remix/router'
import * as s from 'remix/data-schema'
import * as f from 'remix/data-schema/form-data'
import { redirect } from 'remix/response/redirect'
import { addNote, listNotes } from '../data/notes.ts'
import { render } from '../ui/render.tsx'
import { routes } from '../routes.ts'

const noteSchema = f.object({
	text: f.field(s.string()),
})

export default {
	actions: {
		async index(context) {
			const notes = await listNotes(context)
			return render(
				context,
				<main>
					<h1>Notes</h1>
					<ul id="notes">
						{notes.map((note) => (
							<li key={note.id}>{note.text}</li>
						))}
					</ul>
					<form method="post" action={routes.notes.action.href()}>
						<input name="text" />
						<button type="submit">Add</button>
					</form>
				</main>,
			)
		},
		async action(context) {
			const parsed = s.parseSafe(noteSchema, context.get(FormData))
			if (!parsed.success || parsed.value.text.trim().length === 0) {
				return render(
					context,
					<main>
						<h1>Notes</h1>
						<p id="error">A note needs some text.</p>
					</main>,
					{ status: 400 },
				)
			}
			await addNote(context, parsed.value.text.trim())
			return redirect(routes.notes.index.href(), 303)
		},
	},
} satisfies Controller<typeof routes.notes>
`,
		'app/ui/render.tsx': `/** @jsxImportSource remix/component */
import type { RequestContext } from 'remix/router'
import { KodyRuntime } from 'kody:runtime'
import type { RemixNode } from 'remix/component'
import { renderToStream } from 'remix/component/server'
import { createHtmlResponse } from 'remix/response/html'
import { Document } from './document.tsx'

export function render(
	context: RequestContext,
	children: RemixNode,
	init?: ResponseInit,
) {
	const { packageContext } = context.get(KodyRuntime)
	const stream = renderToStream(
		<Document
			appBasePath={packageContext?.appBasePath ?? ''}
			assetBasePath={packageContext?.assetBasePath ?? ''}
			clientModuleUrl={packageContext?.clientModuleUrl ?? null}
		>
			{children}
		</Document>,
		{
			frameSrc: context.url.href,
			onError(error) {
				console.error('SSR render error:', error)
			},
		},
	)
	return createHtmlResponse(stream, init)
}
`,
		'app/ui/layout.tsx': `/** @jsxImportSource remix/component */
import type { Handle, RemixNode } from 'remix/component'
import { routes } from '../routes.ts'

// Server-only: imports the route contract (and so kody:runtime). Islands must
// not import this module; they receive hrefs as props.
export function Layout(handle: Handle<{ children?: RemixNode }>) {
	return () => (
		<div class="layout">
			<nav id="nav">
				<a href={routes.home.href()}>Home</a>
				<a href={routes.notes.index.href()}>Notes</a>
			</nav>
			{handle.props.children}
		</div>
	)
}
`,
		'app/ui/document.tsx': `/** @jsxImportSource remix/component */
import type { Handle, RemixNode } from 'remix/component'
import { Layout } from './layout.tsx'

export function Document(
	handle: Handle<{
		appBasePath: string
		assetBasePath: string
		clientModuleUrl: string | null
		children?: RemixNode
	}>,
) {
	return () => (
		<html lang="en" data-app-base={handle.props.appBasePath}>
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>Remix notes</title>
				<link
					rel="stylesheet"
					href={\`\${handle.props.assetBasePath}/styles.css\`}
				/>
			</head>
			<body>
				<Layout>{handle.props.children}</Layout>
				{handle.props.clientModuleUrl ? (
					<script type="module" src={handle.props.clientModuleUrl}></script>
				) : null}
			</body>
		</html>
	)
}
`,
		'app/ui/counter.tsx': `/** @jsxImportSource remix/component */
import { clientEntry, on, type Handle } from 'remix/component'

export const Counter = clientEntry(
	'kody:app#Counter',
	function Counter(handle: Handle<{ initialCount: number; label: string }>) {
		let count = handle.props.initialCount
		return () => (
			<button
				id="counter"
				type="button"
				mix={on('click', () => {
					count += 1
					handle.update()
				})}
			>
				{handle.props.label}: {count}
			</button>
		)
	},
)
`,
		'app/assets/entry.ts': `import { run } from 'remix/component'
import { Counter } from '../ui/counter.tsx'

// One browser module, so hydration resolves exports here instead of by URL.
const clientEntries: Record<string, unknown> = { Counter }

const app = run({
	async loadModule(_moduleUrl, exportName) {
		const component = clientEntries[exportName]
		if (typeof component !== 'function') {
			throw new Error(\`Unknown client entry "\${exportName}"\`)
		}
		return component
	},
})

app.addEventListener('error', (event) => {
	console.error('Hydration error:', event.error)
})

void app.ready().then(() => {
	document.documentElement.dataset.hydrated = 'true'
})
`,
		'public/styles.css': 'body { font-family: system-ui, sans-serif; }\n',
	}
	const remixFiles = await loadPackageSuppliedRemixFiles()
	return { ...authored, ...remixFiles }
}
