import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/store/db.ts";
import { appendEvent, listEvents } from "../src/store/events.ts";
import {
  getApproval,
  getDiffProposal,
  hashContentUtf8,
  insertApproval,
  insertDiffProposal,
  insertSession,
  listSessions,
  resumeSessionById,
  updateApprovalResolution,
} from "../src/store/sessions.ts";

const tmpRoot = mkdtempSync(join(tmpdir(), "harnessd-store-"));
const dbPath = join(tmpRoot, "test.db");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("database creation", () => {
  test("openDatabase creates file and applies migrations", () => {
    const db = openDatabase(dbPath);
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("sessions");
    db.close();
  });
});

describe("session insertion and resume lookup", () => {
  test("insertSession and resumeSessionById round-trip", () => {
    const db = openDatabase(dbPath);
    insertSession(db, {
      id: "sess-resume",
      workspaceRoot: "/tmp/ws",
      provider: "fake",
      providerSessionId: "native-1",
      metadata: { foo: "bar" },
    });
    const s = resumeSessionById(db, "sess-resume");
    expect(s).not.toBeNull();
    expect(s!.id).toBe("sess-resume");
    expect(s!.provider).toBe("fake");
    expect(s!.providerSessionId).toBe("native-1");
    expect(s!.metadata).toEqual({ foo: "bar" });
    db.close();
  });

  test("listSessions returns inserted rows", () => {
    const db = openDatabase(dbPath);
    insertSession(db, {
      id: "sess-list-b",
      workspaceRoot: "/w",
      provider: "codex",
      providerSessionId: null,
      metadata: {},
    });
    const all = listSessions(db);
    const ids = new Set(all.map((r) => r.id));
    expect(ids.has("sess-list-b")).toBe(true);
    db.close();
  });
});

describe("event append", () => {
  test("appendEvent assigns monotonic seq per session", () => {
    const db = openDatabase(dbPath);
    insertSession(db, {
      id: "sess-ev",
      workspaceRoot: "/w",
      provider: "fake",
      providerSessionId: null,
      metadata: {},
    });
    const a = appendEvent(db, "sess-ev", {
      event: "message.delta",
      timestamp: 100,
      payload: { text: "a", provider: { x: 1 } },
    });
    const b = appendEvent(db, "sess-ev", {
      event: "tool.started",
      timestamp: 101,
      payload: { name: "bash" },
    });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    const listed = listEvents(db, "sess-ev");
    expect(listed).toHaveLength(2);
    expect(listed[0]!.payload).toEqual({ text: "a", provider: { x: 1 } });
    db.close();
  });
});

describe("approval storage", () => {
  test("insertApproval and getApproval with resolution", () => {
    const db = openDatabase(dbPath);
    insertSession(db, {
      id: "sess-appr",
      workspaceRoot: "/w",
      provider: "fake",
      providerSessionId: null,
      metadata: {},
    });
    insertApproval(db, {
      id: "ap-1",
      sessionId: "sess-appr",
      turnId: "turn-1",
      state: "pending",
      request: { kind: "tool", tool: "run" },
    });
    let g = getApproval(db, "ap-1");
    expect(g?.state).toBe("pending");
    expect(g?.request).toEqual({ kind: "tool", tool: "run" });
    updateApprovalResolution(db, "ap-1", {
      state: "approved_once",
      resolution: { choice: 1 },
    });
    g = getApproval(db, "ap-1");
    expect(g?.state).toBe("approved_once");
    expect(g?.resolution).toEqual({ choice: 1 });
    db.close();
  });
});

describe("diff proposal storage", () => {
  test("insertDiffProposal stores path, hash, proposed content, and provider payload", () => {
    const db = openDatabase(dbPath);
    insertSession(db, {
      id: "sess-diff",
      workspaceRoot: "/w",
      provider: "fake",
      providerSessionId: null,
      metadata: {},
    });
    const proposedContent = "export const x = 1;\n";
    insertDiffProposal(db, {
      id: "dp-1",
      sessionId: "sess-diff",
      turnId: "t9",
      path: "src/a.ts",
      state: "pending",
      proposedContent,
      originalContentHash: hashContentUtf8(""),
      provider: { codex: { revisionToken: "abc" } },
    });
    const got = getDiffProposal(db, "dp-1");
    expect(got?.path).toBe("src/a.ts");
    expect(got?.state).toBe("pending");
    expect(got?.proposal.proposedContent).toBe(proposedContent);
    expect(got?.proposal.originalContentHash).toBe(hashContentUtf8(""));
    expect(got?.proposal.provider).toEqual({ codex: { revisionToken: "abc" } });
    db.close();
  });
});
