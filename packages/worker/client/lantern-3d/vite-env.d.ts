// The one Vite build constant the lantern reads. The client tsconfig loads no
// ambient types, and `vite/client` would bring its asset modules along too.
interface ImportMeta {
	readonly env: { readonly SSR: boolean }
}
