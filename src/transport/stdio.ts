import { RuntimeProcess, type SpawnOptions } from "../core/lifecycle.js";
import type { RuntimeTransport } from "./transport.js";

/**
 * StdioTransport — Phase 7 first transport.
 * Wraps RuntimeProcess and exposes raw stdout bytes.
 * No parsing (Rule 3).
 */
export class StdioTransport implements RuntimeTransport {
  private readonly process: RuntimeProcess;
  private started = false;

  public constructor(options: SpawnOptions) {
    this.process = new RuntimeProcess(options);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async start(): Promise<void> {
    if (this.started) return;
    this.process.spawn();
    this.started = true;
  }

  public async write(data: Uint8Array | string): Promise<void> {
    await this.process.write(data);
  }

  public endStdin(): void {
    this.process.endStdin();
  }

  public async *events(): AsyncIterable<Uint8Array> {
    const stdout = this.process.stdout;
    if (!stdout) return;
    // Node Readable → async iterable
    for await (const chunk of stdout as AsyncIterable<Buffer>) {
      yield new Uint8Array(chunk);
    }
  }

  public eventsWithStderr(): AsyncIterable<{ source: "stdout" | "stderr"; data: Uint8Array }> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const stdout = self.process.stdout;
        const stderr = self.process.stderr;
        if (stdout) {
          for await (const chunk of stdout as AsyncIterable<Buffer>) {
            yield { source: "stdout" as const, data: new Uint8Array(chunk) };
          }
        }
        if (stderr) {
          for await (const chunk of stderr as AsyncIterable<Buffer>) {
            yield { source: "stderr" as const, data: new Uint8Array(chunk) };
          }
        }
      },
    };
  }

  public async close(): Promise<void> {
    await this.process.close();
    this.started = false;
  }

  public get pid(): number | undefined {
    return this.process.pid;
  }

  public get state(): string {
    return this.process.state;
  }
}
