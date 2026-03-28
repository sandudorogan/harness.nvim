import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashContentUtf8, insertDiffProposal } from "../../diff/proposals.ts";
import { insertApproval, resumeSessionById } from "../../store/sessions.ts";
import type { PromptTurnContext, ProviderAdapter } from "../base.ts";

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class FakeProviderAdapter implements ProviderAdapter {
  readonly providerId = "fake";
  private readonly approvalContinuations = new Map<string, () => void>();

  notifyApprovalResolved(approvalId: string): void {
    const c = this.approvalContinuations.get(approvalId);
    if (c) {
      this.approvalContinuations.delete(approvalId);
      c();
    }
  }

  async onPromptTurn(ctx: PromptTurnContext): Promise<void> {
    const { sessionId, turnId, text, db, emit } = ctx;
    const needsApproval = text.includes("approval");

    const now = () => Date.now();

    for (const part of ["Fake ", "assistant"]) {
      emit({
        event: "message.delta",
        sessionId,
        timestamp: now(),
        payload: { turnId, text: part },
      });
      await sleepMs(0);
    }

    if (needsApproval) {
      const approvalId = randomUUID();
      insertApproval(db, {
        id: approvalId,
        sessionId,
        turnId,
        state: "pending",
        request: { tool: "demo_tool" },
      });
      emit({
        event: "approval.requested",
        sessionId,
        timestamp: now(),
        payload: { turnId, approvalId, tool: "demo_tool" },
      });
      await new Promise<void>((resolve) => {
        this.approvalContinuations.set(approvalId, resolve);
      });
    }

    const diffId = randomUUID();
    const relPath = "demo.txt";
    const row = resumeSessionById(db, sessionId);
    const wsRoot = row?.workspaceRoot ?? process.cwd();
    let original = "";
    try {
      original = readFileSync(join(wsRoot, relPath), "utf8");
    } catch {
      /* file may not exist yet */
    }
    const proposedContent = "// fake edit\n";
    insertDiffProposal(db, {
      id: diffId,
      sessionId,
      turnId,
      path: relPath,
      state: "pending",
      proposedContent,
      originalContentHash: hashContentUtf8(original),
      provider: { path: relPath },
    });
    emit({
      event: "diff.ready",
      sessionId,
      timestamp: now(),
      payload: { turnId, diffId, path: relPath, provider: { path: relPath } },
    });

    emit({
      event: "message.completed",
      sessionId,
      timestamp: now(),
      payload: { turnId },
    });
  }
}
