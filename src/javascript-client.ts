import { Worker } from "node:worker_threads";

import type { EngineResult, JavaScriptJob } from "./types.js";

type Reply = { ok: true; result: EngineResult } | { ok: false; error: string };

export function runJavaScriptWorker(job: JavaScriptJob): Promise<EngineResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./javascript-worker.js", import.meta.url),
      {
        workerData: job,
        resourceLimits: {
          maxOldGenerationSizeMb: 512,
        },
      },
    );

    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (error?: Error, result?: EngineResult): void => {
      if (settled) {
        return;
      }

      settled = true;

      if (timer) {
        clearTimeout(timer);
      }

      void worker.terminate().catch(() => undefined);

      if (error) {
        reject(error);
      } else {
        resolve(result!);
      }
    };

    timer = setTimeout(() => {
      finish(new Error("JavaScript transformation exceeded 120 seconds."));
    }, 120_000);

    worker.once("message", (reply: Reply) => {
      if (reply.ok) {
        finish(undefined, reply.result);
      } else {
        finish(new Error(reply.error));
      }
    });

    worker.once("error", (error) => finish(error));

    worker.once("exit", (code) => {
      if (!settled) {
        finish(new Error(`JavaScript worker exited without a result: ${code}`));
      }
    });
  });
}
