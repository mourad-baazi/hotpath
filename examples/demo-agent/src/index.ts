import { runAgent } from "./agent.js";

const argv = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

const task = argValue("--task") ?? "morning-brief";
const date = argValue("--date") ?? new Date().toISOString().slice(0, 10);

runAgent({ task, date }).catch((err) => {
  console.error(
    `demo-agent: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
