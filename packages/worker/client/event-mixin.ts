import {
	type ElementProps,
	type MixinDescriptor,
	on as remixOn,
} from 'remix/ui'

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
