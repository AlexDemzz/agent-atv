export type ErrorDetails = Record<string, unknown>;

export class AtvError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly details: ErrorDetails;
  readonly status: number | undefined;
  readonly exitCode: number | undefined;

  constructor(
    code: string,
    message: string,
    options: { hint?: string; details?: ErrorDetails; status?: number; exitCode?: number } = {},
  ) {
    super(message);
    this.name = 'AtvError';
    this.code = code;
    this.hint = options.hint ?? '';
    this.details = options.details ?? {};
    this.status = options.status;
    this.exitCode = options.exitCode;
  }

  toBody(): { error: { code: string; message: string; hint: string; details: ErrorDetails } } {
    return { error: { code: this.code, message: this.message, hint: this.hint, details: this.details } };
  }
}

export function usageError(message: string, hint = 'Run agent-atv --help for usage.', details: ErrorDetails = {}): AtvError {
  return new AtvError('USAGE', message, { hint, details });
}
