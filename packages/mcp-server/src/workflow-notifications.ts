import { randomUUID } from "node:crypto";

export interface WorkflowNotificationRequest {
  action: "claim" | "sent" | "release";
  runId: string;
  eventId: string;
  viewId: string;
  token?: string;
}

interface NotificationClaim {
  runId: string;
  viewId: string;
  token: string;
  expiresAt: number;
  sent: boolean;
}

/** Shared by every request and App view of a project in this daemon. Never evict a sent
 * receipt to make room: doing so would repeat old conversation notifications on reopen. */
export class WorkflowNotificationClaims {
  private readonly scopes = new Map<string, Map<string, NotificationClaim>>();
  constructor(private readonly now = Date.now) {}

  handle(scope: string, request: WorkflowNotificationRequest): { send: boolean; token?: string } | { ok: true } {
    let entries = this.scopes.get(scope);
    if (!entries) {
      if (this.scopes.size >= 256) return request.action === "claim" ? { send: false } : { ok: true };
      entries = new Map();
      this.scopes.set(scope, entries);
    }
    const key = `${request.runId}\0${request.eventId}`;
    const claim = entries.get(key);
    if (request.action === "claim") {
      if (claim?.sent || (claim && claim.expiresAt > this.now())) return { send: false };
      for (const [oldKey, old] of entries) if (!old.sent && old.expiresAt <= this.now()) entries.delete(oldKey);
      if (entries.size >= 4096) return { send: false };
      const token = randomUUID();
      entries.set(key, { runId: request.runId, viewId: request.viewId, token, expiresAt: this.now() + 30_000, sent: false });
      return { send: true, token };
    }
    if (claim && claim.viewId === request.viewId && claim.token === request.token) {
      if (request.action === "sent") claim.sent = true;
      else if (!claim.sent) entries.delete(key);
    }
    return { ok: true };
  }

  deleteRun(runId: string): void {
    for (const entries of this.scopes.values()) {
      for (const [key, claim] of entries) if (claim.runId === runId) entries.delete(key);
    }
  }
}
