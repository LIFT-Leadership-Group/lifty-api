export interface PublicErrorOptions {
  status: number;
  code: string;
  message: string;
  cause?: unknown;
}

export class PublicError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(options: PublicErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "PublicError";
    this.status = options.status;
    this.code = options.code;
  }
}
