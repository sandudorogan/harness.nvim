import type { Database } from "bun:sqlite";
import type { DaemonEvent, PersistedEventRow } from "../protocol/types.ts";
import { persistedEventRowShape } from "../protocol/types.ts";

export type AppendEventInput = {
  event: string;
  timestamp: number;
  payload: DaemonEvent["payload"];
};

export function appendEvent(
  db: Database,
  sessionId: string,
  input: AppendEventInput,
): PersistedEventRow {
  return db.transaction(() => {
    const row = db
      .query("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE session_id = ?")
      .get(sessionId) as { m: number };
    const seq = row.m + 1;
    const ev: DaemonEvent = {
      event: input.event,
      sessionId,
      timestamp: input.timestamp,
      payload: input.payload,
    };
    const shape = persistedEventRowShape(ev, seq);
    db.run(
      `INSERT INTO events (session_id, seq, event, timestamp, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
      [sessionId, seq, input.event, input.timestamp, JSON.stringify(input.payload)],
    );
    return shape;
  })();
}

export type StoredEventRow = PersistedEventRow;

export function listEvents(db: Database, sessionId: string): StoredEventRow[] {
  const rows = db
    .query(
      `SELECT seq, event, timestamp, payload_json AS payload_json
       FROM events WHERE session_id = ? ORDER BY seq ASC`,
    )
    .all(sessionId) as Array<{
    seq: number;
    event: string;
    timestamp: number;
    payload_json: string;
  }>;
  return rows.map((r) => ({
    seq: r.seq,
    event: r.event,
    timestamp: r.timestamp,
    payload: JSON.parse(r.payload_json) as DaemonEvent["payload"],
  }));
}
