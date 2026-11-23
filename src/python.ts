import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { EngineResult, Mode } from "./types.js";

const workerPath = fileURLToPath(
  new URL("../python/worker.py", import.meta.url),
);

export function runPythonWorker(
  source: string,
  filename: string,
  mode: Mode,
  seed: number,
  executable: string,
): Promise<EngineResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      ["-I", "-B", "-S", workerPath],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        try {
          if (!stdout.trim()) {
            throw new Error(
              `Python worker failed: ${
                error?.message || stderr || "empty response"
              }`,
            );
          }

          const response = JSON.parse(stdout) as EngineResult & {
            error?: string;
          };

          if (response.error) {
            throw new Error(response.error);
          }

          if (error) {
            throw error;
          }

          if (
            typeof response.code !== "string" ||
            !response.stats ||
            !Array.isArray(response.warnings)
          ) {
            throw new Error("Invalid Python worker response.");
          }

          resolve({
            code: response.code,
            stats: response.stats,
            warnings: response.warnings,
          });
        } catch (failure) {
          reject(
            failure instanceof Error ? failure : new Error(String(failure)),
          );
        }
      },
    );

    // A startup failure can close stdin before the JSON is written.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(JSON.stringify({ source, filename, mode, seed }));
  });
}
