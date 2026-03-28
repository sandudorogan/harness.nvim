import type { Database } from "bun:sqlite";
import type { DaemonEvent } from "../protocol/types.ts";

export type EmitFn = (event: DaemonEvent) => void;

export type LineTransport = {
  writeLine(line: string): void;
  readLine(): Promise<string>;
  close(): Promise<void>;
};

export type PromptTurnContext = {
  sessionId: string;
  turnId: string;
  text: string;
  db: Database;
  emit: EmitFn;
};

export interface ProviderAdapter {
  readonly providerId: string;
  onPromptTurn(ctx: PromptTurnContext): Promise<void>;
  notifyApprovalResolved(approvalId: string): void;
  archiveSession?(): Promise<void>;
}
