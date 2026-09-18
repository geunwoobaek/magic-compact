import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  type AutoCompactState,
  decideAutoCompact,
  isAutoCompactEnabled,
  isProcessAlive,
  parsePreCompactHookInput,
  readState,
  resolveBudgets,
  statePath,
  transcriptSize,
  writeState,
} from "./auto-compact";

type HookOutput = {
  decision?: "block";
  reason?: string;
  suppressOutput?: boolean;
};

/**
 * Runs on Claude Code's `PreCompact` event for automatic compaction.
 *
 * The hook only decides; it never compacts. Claude Code does not wait for a
 * `PreCompact` hook before starting its own compaction, so a hook that
 * compacts first answers too late: built-in compaction lands, the late block
 * reverts it, and the conversation is compacted by the built-in summary on the
 * very next attempt. Answering immediately keeps the block ahead of that race
 * and leaves the real work to a background worker.
 *
 * Every failure path stays silent so built-in compaction still runs.
 */
async function main(): Promise<void> {
  try {
    const rawInput = await Bun.stdin.text();
    if (!isAutoCompactEnabled(process.env)) {
      writeHookOutput({ suppressOutput: true });
      return;
    }

    const input = parsePreCompactHookInput(rawInput);
    if (input.trigger !== "auto") {
      writeHookOutput({ suppressOutput: true });
      return;
    }

    const path = statePath(input.session_id);
    const state = await readState(path);
    const decision = decideAutoCompact(state, {
      now: Date.now(),
      transcriptBytes: await transcriptSize(input.transcript_path),
      budgets: resolveBudgets(process.env),
      isWorkerAlive: isProcessAlive,
    });

    switch (decision.kind) {
      case "start": {
        await startWorker(path, input.session_id, input.transcript_path);
        writeHookOutput({ decision: "block", reason: IN_PROGRESS_REASON });
        return;
      }
      case "wait": {
        writeHookOutput({ decision: "block", reason: IN_PROGRESS_REASON });
        return;
      }
      case "announce": {
        if (state !== null) {
          await writeState(path, { ...state, announced: true });
        }
        writeHookOutput({
          decision: "block",
          reason: [
            "Magic Compact compacted this session, and Claude Code's built-in",
            "compaction was skipped on purpose.",
            "Tell the user, verbatim, to run this command to enter the",
            "compacted session:",
            `/resume ${decision.destinationSessionId}`,
          ].join("\n"),
        });
        return;
      }
      case "yield": {
        writeHookOutput({ suppressOutput: true });
        return;
      }
    }
  } catch {
    // Never block compaction because of a fault in this hook.
    writeHookOutput({ suppressOutput: true });
  }
}

/**
 * Starts the background compaction. The worker records its own pid so this
 * process never writes the state file again while the worker owns it.
 */
async function startWorker(
  path: string,
  sessionId: string,
  transcriptPath: string,
): Promise<void> {
  const state: AutoCompactState = {
    phase: "running",
    startedAt: Date.now(),
    sourceSessionId: sessionId,
    transcriptPath,
    transcriptBytes: await transcriptSize(transcriptPath),
    workerPid: null,
    destinationSessionId: null,
    announced: false,
    failure: null,
  };
  await writeState(path, state);

  const worker = spawn(
    process.execPath,
    [fileURLToPath(new URL("./auto-compact-worker.ts", import.meta.url)), path],
    { detached: true, stdio: "ignore" },
  );
  worker.unref();

  if (worker.pid === undefined) {
    await writeState(path, {
      ...state,
      phase: "failed",
      failure: "Could not start the background compaction worker.",
    });
    throw new Error("Could not start the background compaction worker.");
  }
}

const IN_PROGRESS_REASON = [
  "Magic Compact is compacting this session in the background, and Claude",
  "Code's built-in compaction was skipped on purpose.",
  "Continue the current task; the resume command follows once compaction",
  "finishes.",
].join("\n");

function writeHookOutput(output: HookOutput): void {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

await main();
