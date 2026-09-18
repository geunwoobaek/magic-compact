import { mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type PreCompactHookInput = {
  session_id: string;
  transcript_path: string;
  hook_event_name: "PreCompact";
  trigger: string;
};

export type AutoCompactState = {
  phase: "running" | "ready" | "failed";
  startedAt: number;
  sourceSessionId: string;
  transcriptPath: string;
  transcriptBytes: number;
  workerPid: number | null;
  destinationSessionId: string | null;
  announced: boolean;
  failure: string | null;
};

export type AutoCompactDecision =
  | { kind: "start" }
  | { kind: "wait" }
  | { kind: "announce"; destinationSessionId: string }
  | { kind: "yield"; reason: YieldReason };

export type YieldReason =
  | "already-announced"
  | "budget-exhausted"
  | "session-grew"
  | "worker-gone"
  | "previous-attempt-failed";

/**
 * How long built-in compaction may be held off while a background compaction
 * runs. Past this point the hook steps aside so a session can never grow
 * without bound because a worker stalled.
 */
export const DEFAULT_BLOCK_BUDGET_MS = 600_000;

/**
 * How much the transcript may grow while compaction is held off.
 *
 * Holding built-in compaction off keeps a conversation above its automatic
 * compaction threshold, which eats into whatever headroom is left before the
 * model's context limit. A conversation that keeps growing through that window
 * can run out of context entirely, and the request fails.
 *
 * A transcript grows by roughly four bytes per token of context, so this
 * default lets a held-off conversation consume on the order of thirty thousand
 * tokens of headroom before Magic Compact steps aside. Raising it holds
 * compaction off through busier turns at the cost of a thinner margin.
 */
export const DEFAULT_GROWTH_BUDGET_BYTES = 128 * 1024;

export type AutoCompactBudgets = {
  blockBudgetMs: number;
  growthBudgetBytes: number;
};

/**
 * Both budgets protect headroom that only the user can see, because a hook
 * cannot read the model's context limit or the threshold compaction fired at.
 * Users whose threshold leaves a wide margin can spend more of it.
 */
export function resolveBudgets(
  environment: Record<string, string | undefined>,
): AutoCompactBudgets {
  return {
    blockBudgetMs:
      positiveNumber(environment["MAGIC_COMPACT_AUTO_BLOCK_SECONDS"], 1_000)
      ?? DEFAULT_BLOCK_BUDGET_MS,
    growthBudgetBytes:
      positiveNumber(environment["MAGIC_COMPACT_AUTO_GROWTH_KB"], 1_024)
      ?? DEFAULT_GROWTH_BUDGET_BYTES,
  };
}

function positiveNumber(
  value: string | undefined,
  scale: number,
): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed * scale;
}

export function parsePreCompactHookInput(
  rawInput: string,
): PreCompactHookInput {
  const input: unknown = JSON.parse(rawInput);
  if (!isRecord(input)) {
    throw new Error("Hook input must be a JSON object.");
  }

  if (
    typeof input["session_id"] !== "string"
    || typeof input["transcript_path"] !== "string"
    || input["hook_event_name"] !== "PreCompact"
    || typeof input["trigger"] !== "string"
  ) {
    throw new Error("Hook input is missing required PreCompact fields.");
  }

  return {
    session_id: input["session_id"],
    transcript_path: input["transcript_path"],
    hook_event_name: "PreCompact",
    trigger: input["trigger"],
  };
}

/**
 * Automatic compaction replaces a built-in Claude Code behavior, so it stays
 * off until a user asks for it.
 */
export function isAutoCompactEnabled(
  environment: Record<string, string | undefined>,
): boolean {
  const value = environment["MAGIC_COMPACT_AUTO"];
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

export type AutoCompactContext = {
  now: number;
  transcriptBytes: number;
  budgets: AutoCompactBudgets;
  isWorkerAlive: (pid: number) => boolean;
};

/**
 * Decides what a `PreCompact` hook invocation should do. Kept free of I/O so
 * every branch is directly testable.
 */
export function decideAutoCompact(
  state: AutoCompactState | null,
  context: AutoCompactContext,
): AutoCompactDecision {
  if (state === null) {
    return { kind: "start" };
  }

  switch (state.phase) {
    case "running": {
      if (context.now - state.startedAt >= context.budgets.blockBudgetMs) {
        return { kind: "yield", reason: "budget-exhausted" };
      }
      if (
        context.transcriptBytes - state.transcriptBytes
        >= context.budgets.growthBudgetBytes
      ) {
        return { kind: "yield", reason: "session-grew" };
      }
      if (state.workerPid !== null && !context.isWorkerAlive(state.workerPid)) {
        return { kind: "yield", reason: "worker-gone" };
      }
      return { kind: "wait" };
    }
    case "ready": {
      if (!state.announced && state.destinationSessionId !== null) {
        return {
          kind: "announce",
          destinationSessionId: state.destinationSessionId,
        };
      }
      return { kind: "yield", reason: "already-announced" };
    }
    case "failed": {
      return { kind: "yield", reason: "previous-attempt-failed" };
    }
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // An owned process that exists but denies signals still counts as alive.
    return isRecord(error) && error["code"] === "EPERM";
  }
}

export async function transcriptSize(transcriptPath: string): Promise<number> {
  try {
    return (await stat(transcriptPath)).size;
  } catch {
    return 0;
  }
}

export function statePath(sessionId: string): string {
  return join(stateDirectory(), `${sessionId}.json`);
}

export async function readState(
  path: string,
): Promise<AutoCompactState | null> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(content);
    return isAutoCompactState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Written through a temporary file because the hook and its worker can touch
 * the same state while a compaction is in flight.
 */
export async function writeState(
  path: string,
  state: AutoCompactState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(state)}\n`);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/** Marks the summarization request compaction writes into the source session. */
const COMPACTION_MARKER = "Conversation Compaction Required";

const USER_ROW = /"type"\s*:\s*"user"/;

/**
 * Counts the user rows a transcript gained from the conversation itself.
 *
 * Whether a compaction raced the conversation cannot be answered by file size
 * or by a plain row count, because compacting writes its own exchange back into
 * the source session: one user row asking for a summary and the assistant rows
 * answering it. That request carries {@link COMPACTION_MARKER}, so skipping it
 * leaves a count that only the conversation can move. Tool results are user
 * rows too, which is what makes this the right signal: a session still working
 * through a turn has moved on just as surely as one the user typed into.
 */
export function countConversationTurns(transcript: string): number {
  return transcript
    .split("\n")
    .filter(line => USER_ROW.test(line) && !line.includes(COMPACTION_MARKER))
    .length;
}

function stateDirectory(): string {
  return `${homedir()}/.claude/magic-compact/auto`;
}

function isAutoCompactState(value: unknown): value is AutoCompactState {
  return (
    isRecord(value)
    && (value["phase"] === "running"
      || value["phase"] === "ready"
      || value["phase"] === "failed")
    && typeof value["startedAt"] === "number"
    && typeof value["sourceSessionId"] === "string"
    && typeof value["transcriptPath"] === "string"
    && typeof value["transcriptBytes"] === "number"
    && (value["workerPid"] === null || typeof value["workerPid"] === "number")
    && (value["destinationSessionId"] === null
      || typeof value["destinationSessionId"] === "string")
    && typeof value["announced"] === "boolean"
    && (value["failure"] === null || typeof value["failure"] === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
