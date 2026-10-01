import { readFile, unlink, writeFile } from "node:fs/promises";

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One daemon (or run-due) per project: create the lock file exclusively,
 * taking over a lock left behind by a process that is gone.
 * Resolves with a release function.
 */
export async function acquireLock(
  file: string,
  pid: number = process.pid,
  isAlive: (pid: number) => boolean = processAlive,
): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, `${pid}\n`, { flag: "wx" });
      return async () => {
        try {
          const owner = Number((await readFile(file, "utf8")).trim());
          if (owner === pid) await unlink(file);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = Number(
        (await readFile(file, "utf8").catch(() => "")).trim(),
      );
      if (
        Number.isInteger(owner) &&
        owner > 0 &&
        owner !== pid &&
        isAlive(owner)
      ) {
        throw new Error(
          `another Hotpath daemon is running for this project (pid ${owner}, lock ${file}) — stop it first`,
        );
      }
      await unlink(file).catch(() => {}); // stale: its process is gone
    }
  }
  throw new Error(`could not take the daemon lock ${file}`);
}
