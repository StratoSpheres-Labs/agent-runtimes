/**
 * Error hierarchy — Dev_Docs/agent_runtimes_dev_plan.md:1701-1722
 * Every error carries `cause` and safe context (never secrets).
 */

export interface RuntimeErrorContext {
  runtime?: string;
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

export class RuntimeError extends Error {
  public readonly context: RuntimeErrorContext;

  public constructor(message: string, context: RuntimeErrorContext = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeError";
    this.context = context;
  }
}

export class RuntimeNotFoundError extends RuntimeError {
  public constructor(message: string, context: RuntimeErrorContext = {}, options?: ErrorOptions) {
    super(message, context, options);
    this.name = "RuntimeNotFoundError";
  }
}

export class RuntimeVersionError extends RuntimeError {
  public constructor(message: string, context: RuntimeErrorContext = {}, options?: ErrorOptions) {
    super(message, context, options);
    this.name = "RuntimeVersionError";
  }
}

export class RuntimeSpawnError extends RuntimeError {
  public constructor(message: string, context: RuntimeErrorContext = {}, options?: ErrorOptions) {
    super(message, context, options);
    this.name = "RuntimeSpawnError";
  }
}

export class RuntimeTimeoutError extends RuntimeError {
  public constructor(message: string, context: RuntimeErrorContext = {}, options?: ErrorOptions) {
    super(message, context, options);
    this.name = "RuntimeTimeoutError";
  }
}

export class RuntimeProtocolError extends RuntimeError {
  public constructor(message: string, context: RuntimeErrorContext = {}, options?: ErrorOptions) {
    super(message, context, options);
    this.name = "RuntimeProtocolError";
  }
}

export class RuntimeSessionError extends RuntimeError {
  public constructor(message: string, context: RuntimeErrorContext = {}, options?: ErrorOptions) {
    super(message, context, options);
    this.name = "RuntimeSessionError";
  }
}
