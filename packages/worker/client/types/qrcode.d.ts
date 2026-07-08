// Minimal typing for the `qrcode` package. The published `@types/qrcode`
// pulls `@types/node` into the DOM-only client tsconfig, which breaks
// `setTimeout` return types, so only the browser API used here is declared.
declare module 'qrcode' {
	export function toDataURL(
		text: string,
		options?: { width?: number; margin?: number },
	): Promise<string>
}
