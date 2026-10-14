/** Shared visual contract for the main and auxiliary conversation composers. */
export const composerBoxClass = 'workbench-composer relative rounded-2xl border bg-surface p-2.5 elev-2 transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)]'
export const composerInputClass = 'max-h-[168px] min-w-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-13 leading-[1.65] text-ink placeholder:text-ink-4'
export const composerToolsClass = 'mt-1 flex min-w-0 flex-nowrap items-center gap-0.5'
export const composerSendClass = 'relative grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full border'
export function composerSendState(busy: boolean, hasDraft: boolean): string {
  return busy ? 'border-danger/40 bg-surface text-danger'
    : hasDraft ? 'border-transparent bg-primary text-white shadow-[0_4px_14px_rgba(47,111,237,0.35)] hover:bg-primary-hover active:scale-95'
      : 'border-line-strong bg-control-2 text-ink-4'
}
