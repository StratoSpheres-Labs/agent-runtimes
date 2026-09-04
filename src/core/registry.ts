import type { RuntimeDefinition } from "../definition/index.js";
import { RuntimeNotFoundError } from "./errors.js";
import { DefaultRuntime, type AgentRuntime } from "./runtime.js";

/**
 * Runtime registry — Phase 2 minimal implementation, Phase 18 factory support.
 * Stores definitions and creates AgentRuntime instances without
 * agent-specific branching (Rule 1). Adapters register a concrete factory
 * (e.g. `() => new OpencodeRuntime()`) so `resolve()` returns the real
 * adapter — never a stub — while core stays generic. No execution logic
 * lives here (plan §25).
 */
export class RuntimeRegistry {
  private readonly definitions = new Map<string, RuntimeDefinition>();
  private readonly factories = new Map<string, () => AgentRuntime>();

  public register(definition: RuntimeDefinition, factory?: () => AgentRuntime): void {
    const id = definition.identity.id;
    this.definitions.set(id, definition);
    this.factories.set(id, factory ?? (() => new DefaultRuntime(definition)));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async resolve(id: string): Promise<AgentRuntime> {
    const factory = this.factories.get(id);
    if (!factory) {
      throw new RuntimeNotFoundError(`Runtime not found: ${id}`, {
        runtime: id,
      });
    }
    return factory();
  }

  public list(): string[] {
    return [...this.definitions.keys()];
  }

  public async detectAll(): Promise<
    Array<{ id: string; status: Awaited<ReturnType<AgentRuntime["detect"]>> }>
  > {
    const ids = [...this.definitions.keys()];
    const results = await Promise.all(
      ids.map(async (id) => {
        const runtime = await this.resolve(id);
        const status = await runtime.detect();
        return { id, status };
      }),
    );
    return results;
  }
}

/** Default global registry — convenience for `src/index.ts` */
export const globalRegistry = new RuntimeRegistry();
