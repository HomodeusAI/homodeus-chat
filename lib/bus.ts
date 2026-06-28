import { EventEmitter } from "node:events";

// In-process pub/sub for SSE fan-out. Fine for a single-node deployment (an internal room).
// Scale-out path: swap for Postgres LISTEN/NOTIFY behind the same publish/subscribe functions.
const g = globalThis as unknown as { __chatBus?: EventEmitter };
const bus = g.__chatBus ?? new EventEmitter();
bus.setMaxListeners(0);
if (process.env.NODE_ENV !== "production") g.__chatBus = bus;

export type RoomEvent = { type: "message"; message: unknown };
export type WakeEvent = { type: "wake"; messageSeq: number };

export function publishRoom(roomId: string, ev: RoomEvent): void {
  bus.emit(`room:${roomId}`, ev);
}

export function subscribeRoom(roomId: string, fn: (ev: RoomEvent) => void): () => void {
  bus.on(`room:${roomId}`, fn);
  return () => bus.off(`room:${roomId}`, fn);
}

export function publishWake(participantId: string, ev: WakeEvent): void {
  bus.emit(`wake:${participantId}`, ev);
}

export function subscribeWake(participantId: string, fn: (ev: WakeEvent) => void): () => void {
  bus.on(`wake:${participantId}`, fn);
  return () => bus.off(`wake:${participantId}`, fn);
}
