import {
	type ElementProps,
	type MixinDescriptor,
	on as remixOn,
} from 'remix/ui'

// Remix `on()` call sites annotate SubmitEvent / MouseEvent / InputEvent and
// also read `currentTarget.value` on untyped handlers. This wrapper is the
// single typed hole; `typescript/no-explicit-any` is off for this file only.
type EventHandler = (event: any, signal: AbortSignal) => void | Promise<void>

export function on<target extends Element>(
	type: string,
	handler: EventHandler,
): MixinDescriptor<target, any, ElementProps> {
	return remixOn(type as never, handler as never) as MixinDescriptor<
		target,
		any,
		ElementProps
	>
}
