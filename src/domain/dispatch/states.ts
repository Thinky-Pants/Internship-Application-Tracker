/**
 * Scheduled-send state machine (see docs/DISPATCH.md).
 *
 *  scheduled ──claim(CAS)──▶ dispatching ──202──▶ submitted ──sent copy found──▶ recorded_sent
 *     │  ▲                       │   │                │
 *     │  └─retryable/throttle────┘   ├─timeout after send request──▶ uncertain ──reconcile──▶ recorded_sent
 *     │                              │                                  └─unresolved─▶ (resolution required)
 *     ├─pause──▶ paused ─resume─▶ scheduled            ├─terminal─▶ failed
 *     ├─ineligible──▶ held ─review─▶ scheduled          └─edit revision─▶ superseded
 *     └─cancel──▶ cancelled
 *
 * Cancellation cutoff: before the atomic claim, cancel is guaranteed. After the
 * claim and before the worker records `send_requested`, a cancel request is
 * honoured. Once the provider request is underway cancellation is best effort
 * and is never shown as a recall.
 */
import type { DbOrTx } from "@/db/client";
import * as s from "@/db/schema";

export const SEND_STATES = ["scheduled", "held", "paused", "dispatching", "submitted", "recorded_sent", "uncertain", "failed", "cancelled", "superseded"] as const;
export type SendState = (typeof SEND_STATES)[number];

export const TRANSITIONS: Record<SendState, SendState[]> = {
  scheduled: ["dispatching", "paused", "held", "cancelled", "superseded", "scheduled"],
  held: ["scheduled", "cancelled", "superseded", "paused"],
  paused: ["scheduled", "held", "cancelled", "superseded"],
  dispatching: ["submitted", "uncertain", "scheduled", "failed", "held", "paused", "cancelled", "superseded", "recorded_sent"],
  submitted: ["recorded_sent", "uncertain"],
  uncertain: ["recorded_sent", "scheduled", "cancelled", "failed"],
  recorded_sent: [],
  failed: ["scheduled", "cancelled"],
  cancelled: [],
  superseded: [],
};

export const TERMINAL: SendState[] = ["recorded_sent", "cancelled", "superseded"];
export const CANCELLABLE: SendState[] = ["scheduled", "held", "paused"];
export const ACTIVE: SendState[] = ["scheduled", "held", "paused", "dispatching", "submitted", "uncertain"];

export function canTransition(from: SendState, to: SendState) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export const STATE_LABEL: Record<SendState, string> = {
  scheduled: "Scheduled (planned time)",
  held: "Held — needs review",
  paused: "Paused",
  dispatching: "Dispatching",
  submitted: "Submitted to provider (accepted, not yet confirmed sent)",
  recorded_sent: "Recorded sent (sent copy found in mailbox)",
  uncertain: "Uncertain — outcome being reconciled",
  failed: "Failed",
  cancelled: "Cancelled",
  superseded: "Superseded by a newer revision",
};

/** Message.status mirrors the send for outbound messages. */
export function messageStatusFor(state: SendState): string {
  return state === "superseded" ? "awaiting_approval" : state;
}

export async function logTransition(
  db: DbOrTx,
  e: { ownerId: string; scheduledSendId?: string | null; messageId?: string | null; from: string | null; to: string; reason?: string; actor: string; data?: Record<string, unknown>; at?: Date },
) {
  await db.insert(s.queueEvents).values({
    ownerId: e.ownerId,
    scheduledSendId: e.scheduledSendId ?? null,
    messageId: e.messageId ?? null,
    fromState: e.from,
    toState: e.to,
    reason: e.reason ?? null,
    actor: e.actor,
    data: e.data ?? {},
    at: e.at ?? new Date(),
  });
}
