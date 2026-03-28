import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export type DiffProposalPayload = {
  proposedContent: string;
  originalContentHash: string;
  provider?: Record<string, unknown>;
};

export type InsertDiffProposalInput = {
  id: string;
  sessionId: string;
  turnId: string | null;
  path: string;
  state: string;
  proposedContent: string;
  originalContentHash: string;
  provider?: Record<string, unknown>;
};

export type DiffProposalRow = {
  id: string;
  sessionId: string;
  turnId: string | null;
  path: string;
  state: string;
  proposal: DiffProposalPayload;
};

export function hashContentUtf8(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function insertDiffProposal(db: Database, input: InsertDiffProposalInput): void {
  const now = Date.now();
  const payload: DiffProposalPayload = {
    proposedContent: input.proposedContent,
    originalContentHash: input.originalContentHash,
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
  };
  db.run(
    `INSERT INTO diff_proposals (id, session_id, turn_id, path, state, proposal_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.sessionId,
      input.turnId,
      input.path,
      input.state,
      JSON.stringify(payload),
      now,
      now,
    ],
  );
}

export function getDiffProposal(db: Database, id: string): DiffProposalRow | null {
  const r = db
    .query(
      `SELECT id, session_id, turn_id, path, state, proposal_json
       FROM diff_proposals WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        session_id: string;
        turn_id: string | null;
        path: string;
        state: string;
        proposal_json: string;
      }
    | undefined;
  if (!r) return null;
  const proposal = JSON.parse(r.proposal_json) as DiffProposalPayload;
  return {
    id: r.id,
    sessionId: r.session_id,
    turnId: r.turn_id,
    path: r.path,
    state: r.state,
    proposal,
  };
}

export function updateDiffProposalState(db: Database, id: string, state: string): void {
  const now = Date.now();
  db.run(`UPDATE diff_proposals SET state = ?, updated_at = ? WHERE id = ?`, [state, now, id]);
}
