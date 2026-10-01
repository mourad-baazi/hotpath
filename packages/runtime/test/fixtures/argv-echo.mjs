// Stand-in "agent" for tests: records exactly the argv it was started with.
import { writeFileSync } from "node:fs";
import process from "node:process";

writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)));
