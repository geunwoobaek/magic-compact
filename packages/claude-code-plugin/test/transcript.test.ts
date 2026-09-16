import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscriptRows } from "../src/transcript";

describe("reading a transcript", () => {
  test("parses the rows of a transcript that is on disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "magic-compact-"));
    const transcriptPath = join(directory, "session.jsonl");
    await writeFile(
      transcriptPath,
      `${JSON.stringify({ type: "user", uuid: "u1", parentUuid: null })}\n`,
      "utf8",
    );

    const rows = await readTranscriptRows(transcriptPath);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.uuid).toBe("u1");
  });

  test("explains a source transcript that was never written to disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "magic-compact-"));
    const transcriptPath = join(directory, "never-written.jsonl");

    const failure = readTranscriptRows(transcriptPath);

    await expect(failure).rejects.toThrow(/--fork-session/);
    await expect(failure).rejects.toThrow(/Send any other message first/);
  });
});
