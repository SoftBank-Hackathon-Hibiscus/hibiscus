import type { StateStore } from "./state-store.js";
import type { OpenMessage, TunnelTargetAuthorizer } from "./types.js";

export class ManagedTunnelTargetAuthorizer implements TunnelTargetAuthorizer {
  constructor(private readonly stateStore: StateStore) {}

  async authorize(message: OpenMessage): Promise<number | undefined> {
    const state = await this.stateStore.read();
    const managed = Object.values(state.containers).find(
      (container) => container.host_port === message.local_port,
    );
    return managed?.host_port;
  }
}
