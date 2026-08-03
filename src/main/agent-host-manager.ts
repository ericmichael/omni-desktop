/**
 * Compatibility-keyed ownership for long-lived agent hosts.
 *
 * A renderer surface is a consumer of an AgentHost, never its owner. Multiple
 * tabs may attach to one compatible host; detaching one consumer only returns
 * the host for shutdown when the final consumer leaves.
 */

type HostEntry<THost extends object> = {
  key: string;
  host: THost;
  consumers: Set<string>;
};

export type AgentHostAttachment<THost extends object> = {
  host: THost;
  created: boolean;
  /** A prior host whose final consumer was detached during this attachment. */
  released?: THost;
};

export type AgentHostDetachment<THost extends object> = {
  host: THost;
  lastConsumer: boolean;
};

export class AgentHostManager<THost extends object> {
  private readonly hostsByKey = new Map<string, HostEntry<THost>>();
  private readonly entryByHost = new Map<THost, HostEntry<THost>>();
  private readonly entryByConsumer = new Map<string, HostEntry<THost>>();

  attach(consumerId: string, key: string, create: () => THost): AgentHostAttachment<THost> {
    const current = this.entryByConsumer.get(consumerId);
    if (current?.key === key) {
      return { host: current.host, created: false };
    }

    const detached = current ? this.detach(consumerId) : undefined;
    let target = this.hostsByKey.get(key);
    let created = false;
    if (!target) {
      const host = create();
      target = { key, host, consumers: new Set() };
      this.hostsByKey.set(key, target);
      this.entryByHost.set(host, target);
      created = true;
    }
    target.consumers.add(consumerId);
    this.entryByConsumer.set(consumerId, target);

    return {
      host: target.host,
      created,
      ...(detached?.lastConsumer ? { released: detached.host } : {}),
    };
  }

  detach(consumerId: string): AgentHostDetachment<THost> | undefined {
    const entry = this.entryByConsumer.get(consumerId);
    if (!entry) {
      return undefined;
    }
    this.entryByConsumer.delete(consumerId);
    entry.consumers.delete(consumerId);
    const lastConsumer = entry.consumers.size === 0;
    if (lastConsumer) {
      this.hostsByKey.delete(entry.key);
      this.entryByHost.delete(entry.host);
    }
    return { host: entry.host, lastConsumer };
  }

  hostForConsumer(consumerId: string): THost | undefined {
    return this.entryByConsumer.get(consumerId)?.host;
  }

  consumersForHost(host: THost): string[] {
    return [...(this.entryByHost.get(host)?.consumers ?? [])];
  }

  consumerCount(host: THost): number {
    return this.entryByHost.get(host)?.consumers.size ?? 0;
  }

  canRekey(consumerId: string, newKey: string): boolean {
    const current = this.entryByConsumer.get(consumerId);
    if (!current || current.consumers.size !== 1) {
      return false;
    }
    const target = this.hostsByKey.get(newKey);
    return !target || target === current;
  }

  rekey(consumerId: string, newKey: string): boolean {
    if (!this.canRekey(consumerId, newKey)) {
      return false;
    }
    const entry = this.entryByConsumer.get(consumerId)!;
    if (entry.key === newKey) {
      return true;
    }
    this.hostsByKey.delete(entry.key);
    entry.key = newKey;
    this.hostsByKey.set(newKey, entry);
    return true;
  }

  hosts(): THost[] {
    return [...this.hostsByKey.values()].map((entry) => entry.host);
  }

  clear(): THost[] {
    const hosts = this.hosts();
    this.hostsByKey.clear();
    this.entryByHost.clear();
    this.entryByConsumer.clear();
    return hosts;
  }
}
