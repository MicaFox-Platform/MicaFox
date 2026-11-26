/** Who made a change. */
export interface EventActor {
  userId: string;
}

/** The actor of a change no user made, such as a resend or an SDK that connects. */
export const SYSTEM_ACTOR: EventActor = { userId: "system" };

/**
 * What a part announces once a change is committed: docs/architecture/hub/server.md#events. `type` is
 * `<feature>.<noun>.<verb>`, and `data` holds ids only, as hints of what to reload, never a secret or a content.
 */
export interface HubEvent {
  type: string;
  orgId: string;
  environmentId?: string;
  actor: EventActor;
  data: Record<string, unknown>;
}

// What the stream sends, as server-sent events: the event is named by its type and carries itself as JSON
export const eventFrame = (event: HubEvent): string => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

/** Tells the browser to reload everything: it is the first frame of a stream, and what a stream that fell behind gets. */
export const RESET_FRAME = "event: reset\ndata: {}\n\n";

/** A comment, so a proxy that closes an idle connection does not close the stream. */
export const KEEPALIVE_FRAME = ": keepalive\n\n";
