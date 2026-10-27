/** Project events over Redis pub/sub; the API turns them into SSE (spec 13). */
import IORedis from "ioredis";
import type { ProjectEvent } from "@vp/shared";

const channel = (projectId: string) => `vp:events:${projectId}`;

export class EventBus {
  private readonly pub: IORedis;
  constructor(private readonly url: string) {
    this.pub = new IORedis(url, { maxRetriesPerRequest: null });
  }

  async publish(projectId: string, type: ProjectEvent["type"], data: Record<string, unknown>): Promise<void> {
    const ev: ProjectEvent = { type, projectId, at: new Date().toISOString(), data };
    await this.pub.publish(channel(projectId), JSON.stringify(ev));
  }

  /** Each subscriber gets its own connection (a subscribed connection cannot publish). */
  async subscribe(projectId: string, onEvent: (ev: ProjectEvent) => void): Promise<() => Promise<void>> {
    const sub = new IORedis(this.url, { maxRetriesPerRequest: null });
    await sub.subscribe(channel(projectId));
    sub.on("message", (_ch, msg) => {
      try {
        onEvent(JSON.parse(msg) as ProjectEvent);
      } catch {
        /* ignore malformed */
      }
    });
    return async () => {
      sub.disconnect();
    };
  }

  async close(): Promise<void> {
    this.pub.disconnect();
  }
}
