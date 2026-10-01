import { runRecorder } from "./recorder.js";

// `hotpath record --task <name> -- <server command…>`
const argv = process.argv.slice(2);
const taskIdx = argv.indexOf("--task");
const task = taskIdx >= 0 ? argv[taskIdx + 1] : undefined;
const dash = argv.indexOf("--");
const serverArgv = dash >= 0 ? argv.slice(dash + 1) : [];

if (!task || serverArgv.length === 0) {
  console.error("usage: hotpath record --task <name> -- <server command…>");
  process.exit(1);
}

runRecorder({ task, serverArgv })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(
      `[recorder] fatal: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
