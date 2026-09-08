/**
 * The seam D-115 asks for: sending behind an interface, so changing provider is a
 * config-and-warm-up project rather than a rewrite.
 *
 * That indirection is not speculative generality. The economics lane (D-006,
 * D-023) points at SES at scale, custom per-project SMTP is the top production ask
 * (D-117), and the local stack has no provider account at all — three destinations
 * for the same call, already known.
 */

export interface OutgoingMessage {
  from: string;
  /** A display name, so a recipient sees whose app is talking (`"Acme (via Steadhold)"`). */
  fromName?: string | undefined;
  to: string;
  subject: string;
  html: string;
  /**
   * Required, not optional. A mail with no text part scores worse with every spam
   * filter and is unreadable in a text-only client — and since both parts are
   * rendered from the same template, there is no case where we have one and not
   * the other.
   */
  text: string;
  replyTo?: string | undefined;
  /** Groups messages for provider-side reporting. One per template. */
  tag?: string | undefined;
  /** Correlates a provider webhook back to our `email_sends` row. */
  metadata?: Record<string, string> | undefined;
}

export interface SendResult {
  /** The provider's id for the message, or a locally-generated one. */
  providerId: string;
}

export class EmailSendError extends Error {
  /**
   * Whether trying again could work.
   *
   * The distinction is the whole retry policy: a 4xx from the provider, a refused
   * recipient, a malformed address — retrying those three times over 35 minutes
   * burns the budget and changes nothing. A connection reset or a 421 is worth
   * retrying. Getting this backwards in either direction is expensive: retrying
   * permanent failures delays every other mail behind them, and not retrying
   * transient ones drops mail on a network blip.
   */
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'EmailSendError';
    this.retryable = retryable;
  }
}

export interface EmailProvider {
  readonly name: string;
  send(message: OutgoingMessage): Promise<SendResult>;
}
