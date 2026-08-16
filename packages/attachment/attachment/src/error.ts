/** Attachment failure class. @module @coomi/coomi-attachment/error */

/**
 * Stable failures suitable for host RPC error mapping.
 *
 * Deliberately re-implements the `HarnessError` shape instead of extending it:
 * the base lives in `@coomi/coomi-llm`, which itself depends on this
 * package (`ImageBlock` references `ImageAttachmentRef`), so sharing the base
 * would create a dependency cycle. Consumers route on `code`, never on the
 * prototype chain, so the shapes stay interchangeable at the wire boundary.
 */
export class AttachmentError extends Error {
  /** Stable machine-routing failure code. */
  readonly code: string

  /**
   * @param message - human-readable failure description without raw bytes or host paths.
   * @param code - stable machine-routing code.
   * @param options - optional chained cause.
   */
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AttachmentError'
    this.code = code
  }
}
