import { stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type AutoCompactState,
  countConversationTurns,
  readState,
  writeState,
} from "./auto-compact";
import { compactSession } from "./compact";

/**
 * Compacts a session outside the `PreCompact` hook process.
 *
 * Automatic compaction fires in the middle of a turn, and compaction reads the
 * transcript as it stands when it starts. Waiting for the transcript to stop
 * growing keeps the rest of that turn inside the compacted session.
 */
const QUIET_PERIOD_MS = 5_000;
const QUIET_WAIT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

/**
 * Compaction itself takes long enough for the conversation to move on. A
 * destination built from a transcript that has since grown is missing whatever
 * came after, and resuming into it would drop that work, so a compaction that
 * raced the conversation is thrown away and taken again.
 */
const MAX_COMPACT_ATTEMPTS = 3;

async function main(): Promise<void> {
  const path = process.argv[2];
  if (path === undefined) {
    return;
  }

  const stored = await readState(path);
  if (stored === null) {
    return;
  }

  // The worker owns the state file from here on, so it records its own pid.
  const state: AutoCompactState = { ...stored, workerPid: process.pid };
  await writeState(path, state).catch(() => undefined);

  try {
    let destinationSessionId: string | null = null;
    for (let attempt = 1; attempt <= MAX_COMPACT_ATTEMPTS; attempt += 1) {
      const wentQuiet = await waitForQuietTranscript(state.transcriptPath);
      const before = await conversationTurns(state.transcriptPath);
      const candidate = await compactSession(
        state.transcriptPath,
        state.sourceSessionId,
        0,
      );
      if (candidate === null) {
        await finish(path, state, {
          phase: "failed",
          failure: "No older assistant turns to compact.",
        });
        return;
      }

      if (destinationSessionId !== null) {
        await discardSession(state.transcriptPath, destinationSessionId);
      }
      destinationSessionId = candidate;

      // A session that never went quiet will not go quiet on the next attempt
      // either, so retrying only spends another compaction on an equally stale
      // snapshot.
      if (
        !wentQuiet
        || (await conversationTurns(state.transcriptPath)) === before
      ) {
        break;
      }
    }
    await finish(path, state, { phase: "ready", destinationSessionId });
  } catch (error) {
    await finish(path, state, {
      phase: "failed",
      failure: error instanceof Error ? error.message : String(error),
    });
  }
}

async function finish(
  path: string,
  state: AutoCompactState,
  update: Partial<AutoCompactState>,
): Promise<void> {
  await writeState(path, { ...state, ...update }).catch(() => undefined);
}

/** Resolves to whether the transcript actually went quiet before the timeout. */
async function waitForQuietTranscript(
  transcriptPath: string,
): Promise<boolean> {
  const deadline = Date.now() + QUIET_WAIT_TIMEOUT_MS;
  let previous = await transcriptFingerprint(transcriptPath);
  let quietSince = Date.now();

  while (Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);
    const current = await transcriptFingerprint(transcriptPath);
    if (current !== previous) {
      previous = current;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= QUIET_PERIOD_MS) {
      return true;
    }
  }
  return false;
}

async function conversationTurns(transcriptPath: string): Promise<number> {
  try {
    return countConversationTurns(await Bun.file(transcriptPath).text());
  } catch {
    return 0;
  }
}

/**
 * Removes a compacted session that was superseded, so a discarded attempt does
 * not clutter the user's session list.
 */
async function discardSession(
  sourceTranscriptPath: string,
  sessionId: string,
): Promise<void> {
  const directory = dirname(sourceTranscriptPath);
  await unlink(join(directory, `${sessionId}.jsonl`)).catch(() => undefined);
}

async function transcriptFingerprint(transcriptPath: string): Promise<string> {
  try {
    const stats = await stat(transcriptPath);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return "missing";
  }
}

await main();
