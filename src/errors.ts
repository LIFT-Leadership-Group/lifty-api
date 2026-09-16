export interface UpstreamDiagnostics {
  upstream_operation: string;
  upstream_code?: string;
  upstream_kind: "database_storage" | "database_timeout" | "database_error" | "transport";
}

export interface PublicErrorOptions {
  status: number;
  code: string;
  message: string;
  cause?: unknown;
  diagnostics?: UpstreamDiagnostics;
}

export class PublicError extends Error {
  readonly status: number;
  readonly code: string;
  readonly diagnostics: UpstreamDiagnostics | undefined;

  constructor(options: PublicErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "PublicError";
    this.status = options.status;
    this.code = options.code;
    this.diagnostics = options.diagnostics;
  }
}
