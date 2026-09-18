import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AutoCompactContext,
  type AutoCompactState,
  countConversationTurns,
  decideAutoCompact,
  DEFAULT_BLOCK_BUDGET_MS,
  DEFAULT_GROWTH_BUDGET_BYTES,
  isAutoCompactEnabled,
  parsePreCompactHookInput,
  readState,
  resolveBudgets,
  transcriptSize,
  writeState,
} from "../src/auto-compact";

const alive = (): boolean => true;
const dead = (): boolean => false;

function context(
  overrides: Partial<AutoCompactContext> = {},
): AutoCompactContext {
  return {
    now: 5_000,
    transcriptBytes: 1_000,
    budgets: resolveBudgets({}),
    isWorkerAlive: alive,
    ...overrides,
  };
}

function runningState(
  overrides: Partial<AutoCompactState> = {},
): AutoCompactState {
  return {
    phase: "running",
    startedAt: 1_000,
    sourceSessionId: "source",
    transcriptPath: "/tmp/source.jsonl",
    transcriptBytes: 1_000,
    workerPid: 4242,
    destinationSessionId: null,
    announced: false,
    failure: null,
    ...overrides,
  };
}

describe("parsing PreCompact hook input", () => {
  test("accepts a complete payload", () => {
    const input = parsePreCompactHookInput(
      JSON.stringify({
        session_id: "abc",
        transcript_path: "/tmp/abc.jsonl",
        hook_event_name: "PreCompact",
        trigger: "auto",
      }),
    );

    expect(input.session_id).toBe("abc");
    expect(input.trigger).toBe("auto");
  });

  test("rejects a payload from another hook event", () => {
    expect(() =>
      parsePreCompactHookInput(
        JSON.stringify({
          session_id: "abc",
          transcript_path: "/tmp/abc.jsonl",
          hook_event_name: "UserPromptSubmit",
          trigger: "auto",
        }),
      ),
    ).toThrow(/required PreCompact fields/);
  });

  test("rejects input that is not an object", () => {
    expect(() => parsePreCompactHookInput('"PreCompact"')).toThrow(
      /must be a JSON object/,
    );
  });
});

describe("enabling automatic compaction", () => {
  test("stays off unless asked for", () => {
    expect(isAutoCompactEnabled({})).toBe(false);
    expect(isAutoCompactEnabled({ MAGIC_COMPACT_AUTO: "" })).toBe(false);
    expect(isAutoCompactEnabled({ MAGIC_COMPACT_AUTO: "0" })).toBe(false);
    expect(isAutoCompactEnabled({ MAGIC_COMPACT_AUTO: "false" })).toBe(false);
  });

  test("turns on for any other value", () => {
    expect(isAutoCompactEnabled({ MAGIC_COMPACT_AUTO: "1" })).toBe(true);
    expect(isAutoCompactEnabled({ MAGIC_COMPACT_AUTO: "true" })).toBe(true);
    expect(isAutoCompactEnabled({ MAGIC_COMPACT_AUTO: " True " })).toBe(true);
  });
});

describe("resolving how much headroom may be spent", () => {
  test("falls back to the defaults", () => {
    expect(resolveBudgets({})).toEqual({
      blockBudgetMs: DEFAULT_BLOCK_BUDGET_MS,
      growthBudgetBytes: DEFAULT_GROWTH_BUDGET_BYTES,
    });
  });

  test("takes the budgets a user configured", () => {
    expect(
      resolveBudgets({
        MAGIC_COMPACT_AUTO_BLOCK_SECONDS: "90",
        MAGIC_COMPACT_AUTO_GROWTH_KB: "256",
      }),
    ).toEqual({ blockBudgetMs: 90_000, growthBudgetBytes: 262_144 });
  });

  test("ignores values that are not a positive number", () => {
    for (const value of ["", "0", "-5", "lots"]) {
      expect(
        resolveBudgets({
          MAGIC_COMPACT_AUTO_BLOCK_SECONDS: value,
          MAGIC_COMPACT_AUTO_GROWTH_KB: value,
        }),
      ).toEqual({
        blockBudgetMs: DEFAULT_BLOCK_BUDGET_MS,
        growthBudgetBytes: DEFAULT_GROWTH_BUDGET_BYTES,
      });
    }
  });
});

describe("deciding what a PreCompact invocation does", () => {
  test("starts a compaction when the session has no attempt yet", () => {
    expect(decideAutoCompact(null, context())).toEqual({ kind: "start" });
  });

  test("holds off built-in compaction while a worker runs", () => {
    expect(decideAutoCompact(runningState(), context())).toEqual({
      kind: "wait",
    });
  });

  test("steps aside once the block budget is spent", () => {
    expect(
      decideAutoCompact(
        runningState(),
        context({ now: 1_000 + DEFAULT_BLOCK_BUDGET_MS }),
      ),
    ).toEqual({ kind: "yield", reason: "budget-exhausted" });
  });

  test("steps aside once the session grew past the growth budget", () => {
    expect(
      decideAutoCompact(
        runningState(),
        context({ transcriptBytes: 1_000 + DEFAULT_GROWTH_BUDGET_BYTES }),
      ),
    ).toEqual({ kind: "yield", reason: "session-grew" });
  });

  test("keeps waiting while growth stays inside the budget", () => {
    expect(
      decideAutoCompact(
        runningState(),
        context({ transcriptBytes: 1_000 + DEFAULT_GROWTH_BUDGET_BYTES - 1 }),
      ),
    ).toEqual({ kind: "wait" });
  });

  test("steps aside when the worker died", () => {
    expect(
      decideAutoCompact(runningState(), context({ isWorkerAlive: dead })),
    ).toEqual({ kind: "yield", reason: "worker-gone" });
  });

  test("waits when a worker was never recorded", () => {
    expect(
      decideAutoCompact(
        runningState({ workerPid: null }),
        context({ isWorkerAlive: dead }),
      ),
    ).toEqual({ kind: "wait" });
  });

  test("announces a finished compaction once", () => {
    const ready = runningState({
      phase: "ready",
      destinationSessionId: "destination",
    });

    expect(decideAutoCompact(ready, context())).toEqual({
      kind: "announce",
      destinationSessionId: "destination",
    });
    expect(decideAutoCompact({ ...ready, announced: true }, context())).toEqual(
      { kind: "yield", reason: "already-announced" },
    );
  });

  test("keeps announcing regardless of growth or budget", () => {
    const ready = runningState({
      phase: "ready",
      destinationSessionId: "destination",
    });

    expect(
      decideAutoCompact(
        ready,
        context({
          now: 1_000 + DEFAULT_BLOCK_BUDGET_MS,
          transcriptBytes: 1_000 + DEFAULT_GROWTH_BUDGET_BYTES,
        }),
      ),
    ).toEqual({ kind: "announce", destinationSessionId: "destination" });
  });

  test("steps aside after a failed attempt", () => {
    expect(
      decideAutoCompact(
        runningState({ phase: "failed", failure: "boom" }),
        context(),
      ),
    ).toEqual({ kind: "yield", reason: "previous-attempt-failed" });
  });
});

describe("reading and writing state", () => {
  test("round trips a state file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "magic-compact-auto-"));
    const path = join(directory, "session.json");
    const state = runningState();

    await writeState(path, state);

    expect(await readState(path)).toEqual(state);
  });

  test("treats a missing or damaged state file as no attempt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "magic-compact-auto-"));
    const damaged = join(directory, "damaged.json");
    await writeFile(damaged, "{ not json", "utf8");

    expect(await readState(join(directory, "missing.json"))).toBeNull();
    expect(await readState(damaged)).toBeNull();
  });

  test("ignores a state file written by an incompatible version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "magic-compact-auto-"));
    const path = join(directory, "session.json");
    await writeFile(path, JSON.stringify({ phase: "running" }), "utf8");

    expect(await readState(path)).toBeNull();
  });
});

describe("measuring a transcript", () => {
  test("reports the size of a transcript on disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "magic-compact-auto-"));
    const path = join(directory, "session.jsonl");
    await writeFile(path, "0123456789", "utf8");

    expect(await transcriptSize(path)).toBe(10);
  });

  test("reports zero for a transcript that is not on disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "magic-compact-auto-"));

    expect(await transcriptSize(join(directory, "missing.jsonl"))).toBe(0);
  });
});

describe("counting the turns a conversation recorded", () => {
  const userRow = (text: string) =>
    JSON.stringify({ type: "user", message: { role: "user", content: text } });
  const assistantRow = (text: string) =>
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: text },
    });

  test("counts user rows, including tool results, and ignores assistant rows", () => {
    const transcript = [
      userRow("first"),
      assistantRow("answering"),
      userRow("second"),
    ].join("\n");

    expect(countConversationTurns(transcript)).toBe(2);
  });

  test("ignores the summarization request compaction writes back", () => {
    const transcript = [
      userRow("first"),
      userRow("<system> # Attention: Conversation Compaction Required"),
      assistantRow("<summary>...</summary>"),
    ].join("\n");

    expect(countConversationTurns(transcript)).toBe(1);
  });

  test("holds steady when only a compaction has been recorded", () => {
    const before = [userRow("first"), assistantRow("answering")].join("\n");
    const after = [
      before,
      userRow("<system> # Attention: Conversation Compaction Required"),
      assistantRow("<summary>...</summary>"),
    ].join("\n");

    expect(countConversationTurns(after)).toBe(countConversationTurns(before));
  });

  test("counts nothing in an empty transcript", () => {
    expect(countConversationTurns("")).toBe(0);
  });
});
