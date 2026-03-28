import type { Database } from "bun:sqlite";

export type SessionRow = {
  id: string;
  workspaceRoot: string;
  provider: string;
  providerSessionId: string | null;
  state: string;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
};

export type InsertSessionInput = {
  id: string;
  workspaceRoot: string;
  provider: string;
  providerSessionId: string | null;
  metadata: Record<string, unknown>;
};

export function insertSession(db: Database, input: InsertSessionInput): void {
  const now = Date.now();
  db.run(
    `INSERT INTO sessions (
      id, workspace_root, provider, provider_session_id, state, created_at, updated_at, metadata_json
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    [
      input.id,
      input.workspaceRoot,
      input.provider,
      input.providerSessionId,
      now,
      now,
      JSON.stringify(input.metadata),
    ],
  );
}

function mapSessionRow(r: {
  id: string;
  workspace_root: string;
  provider: string;
  provider_session_id: string | null;
  state: string;
  created_at: number;
  updated_at: number;
  metadata_json: string;
}): SessionRow {
  return {
    id: r.id,
    workspaceRoot: r.workspace_root,
    provider: r.provider,
    providerSessionId: r.provider_session_id,
    state: r.state,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    metadata: JSON.parse(r.metadata_json) as Record<string, unknown>,
  };
}

export function updateSessionProviderBinding(
  db: Database,
  sessionId: string,
  input: { providerSessionId: string; metadata: Record<string, unknown> },
): void {
  const now = Date.now();
  db.run(
    `UPDATE sessions SET provider_session_id = ?, metadata_json = ?, updated_at = ? WHERE id = ?`,
    [input.providerSessionId, JSON.stringify(input.metadata), now, sessionId],
  );
}

export function updateSessionState(db: Database, sessionId: string, state: string): void {
  const now = Date.now();
  db.run(`UPDATE sessions SET state = ?, updated_at = ? WHERE id = ?`, [state, now, sessionId]);
}

export function deleteSessionById(db: Database, sessionId: string): void {
  db.run(`DELETE FROM sessions WHERE id = ?`, [sessionId]);
}

export function resumeSessionById(db: Database, id: string): SessionRow | null {
  const r = db
    .query(
      `SELECT id, workspace_root, provider, provider_session_id, state, created_at, updated_at, metadata_json
       FROM sessions WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        workspace_root: string;
        provider: string;
        provider_session_id: string | null;
        state: string;
        created_at: number;
        updated_at: number;
        metadata_json: string;
      }
    | undefined;
  if (!r) return null;
  return mapSessionRow(r);
}

export function listSessions(db: Database): SessionRow[] {
  const rows = db
    .query(
      `SELECT id, workspace_root, provider, provider_session_id, state, created_at, updated_at, metadata_json
       FROM sessions ORDER BY created_at ASC`,
    )
    .all() as Array<{
    id: string;
    workspace_root: string;
    provider: string;
    provider_session_id: string | null;
    state: string;
    created_at: number;
    updated_at: number;
    metadata_json: string;
  }>;
  return rows.map(mapSessionRow);
}

export function listActiveSessions(db: Database): SessionRow[] {
  return listSessions(db).filter((r) => r.state !== "archived");
}

export type InsertApprovalInput = {
  id: string;
  sessionId: string;
  turnId: string | null;
  state: string;
  request: unknown;
};

export function insertApproval(db: Database, input: InsertApprovalInput): void {
  const now = Date.now();
  db.run(
    `INSERT INTO approvals (id, session_id, turn_id, state, request_json, resolution_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    [input.id, input.sessionId, input.turnId, input.state, JSON.stringify(input.request), now, now],
  );
}

export type ApprovalRow = {
  id: string;
  sessionId: string;
  turnId: string | null;
  state: string;
  request: unknown;
  resolution: unknown | null;
};

export function getApproval(db: Database, id: string): ApprovalRow | null {
  const r = db
    .query(
      `SELECT id, session_id, turn_id, state, request_json, resolution_json
       FROM approvals WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        session_id: string;
        turn_id: string | null;
        state: string;
        request_json: string;
        resolution_json: string | null;
      }
    | undefined;
  if (!r) return null;
  return {
    id: r.id,
    sessionId: r.session_id,
    turnId: r.turn_id,
    state: r.state,
    request: JSON.parse(r.request_json) as unknown,
    resolution: r.resolution_json === null ? null : (JSON.parse(r.resolution_json) as unknown),
  };
}

export function updateApprovalResolution(
  db: Database,
  id: string,
  input: { state: string; resolution: unknown },
): void {
  const now = Date.now();
  db.run(`UPDATE approvals SET state = ?, resolution_json = ?, updated_at = ? WHERE id = ?`, [
    input.state,
    JSON.stringify(input.resolution),
    now,
    id,
  ]);
}

export type { DiffProposalRow, InsertDiffProposalInput } from "../diff/proposals.ts";
export {
  getDiffProposal,
  hashContentUtf8,
  insertDiffProposal,
  updateDiffProposalState,
} from "../diff/proposals.ts";
