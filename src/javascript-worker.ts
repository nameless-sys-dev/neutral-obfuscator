import { parentPort, workerData } from "node:worker_threads";

import { transformJavaScript } from "./javascript.js";
import type { JavaScriptJob } from "./types.js";

if (!parentPort) {
  throw new Error("This module must run as a worker.");
}

try {
  const result = transformJavaScript(workerData as JavaScriptJob);
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  parentPort.close();
}
