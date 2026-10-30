// Echo's error contract: every module tags a failure with an `echoCode` (the
// route maps it to a status and the client to a card), often a `hint` (the next
// step shown to the user) and a `detail` (the raw text behind "Show technical
// details"). The originals set those as properties on a plain Error, which
// TypeScript does not allow and Seshat traps on (gap: error-add-property), so
// the port carries them in one subclass. `name` stays "Error", as before.
export class EchoError extends Error {
  echoCode: string;
  hint?: string;
  detail?: string;
  /** Which error card the client shows (transcript failures: premiere, bot_block, ...). */
  reason?: string;
  constructor(message: string, echoCode: string, hint?: string, detail?: string, reason?: string) {
    super(message);
    this.echoCode = echoCode;
    if (hint !== undefined) this.hint = hint;
    if (detail !== undefined) this.detail = detail;
    if (reason !== undefined) this.reason = reason;
  }
}
