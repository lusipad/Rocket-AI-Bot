import type { AgentRequest, AgentResponse } from './types.js';

export interface AgentCapability {
  id: string;
  description: string;
  priority: number;
  canHandle(request: AgentRequest): boolean | Promise<boolean>;
  handle(request: AgentRequest): Promise<AgentResponse>;
}

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, AgentCapability>();

  register(capability: AgentCapability): void {
    if (this.capabilities.has(capability.id)) {
      throw new Error(`capability 已注册: ${capability.id}`);
    }

    this.capabilities.set(capability.id, capability);
  }

  list(): AgentCapability[] {
    return Array.from(this.capabilities.values())
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  }
}

export class RequestRouter {
  constructor(private readonly registry: CapabilityRegistry) {}

  async handle(request: AgentRequest): Promise<AgentResponse> {
    for (const capability of this.registry.list()) {
      if (await capability.canHandle(request)) {
        return capability.handle(request);
      }
    }

    throw new Error('没有可处理该请求的 capability');
  }
}
