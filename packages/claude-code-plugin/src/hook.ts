import { compactSession } from "./compact";
import { parseHookInput, parseMagicCompactCommand } from "./command";

type HookOutput = {
  continue?: false;
  suppressOutput?: boolean;
  stopReason?: string;
};

async function main(): Promise<void> {
  try {
    const input = parseHookInput(await Bun.stdin.text());
    const keepTurns = parseMagicCompactCommand(input.prompt);
    if (keepTurns === null) {
      writeHookOutput({ suppressOutput: true });
      return;
    }

    const destinationSessionId = await compactSession(
      input.transcript_path,
      input.session_id,
      keepTurns,
    );
    if (destinationSessionId === null) {
      writeHookOutput({
        continue: false,
        stopReason:
          "Magic Compact skipped: no older assistant turns to compact.",
      });
      return;
    }

    writeHookOutput({
      continue: false,
      stopReason: [
        "Magic Compact success.",
        "To enter the compacted session, run the following command:",
        `/resume ${destinationSessionId}`,
      ].join("\n"),
    });
  } catch (error) {
    writeHookOutput({
      continue: false,
      stopReason: `Magic Compact failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function writeHookOutput(output: HookOutput): void {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

await main();
