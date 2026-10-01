import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadWorkflow } from "hotpath-compiler";

const viewerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export interface ViewerOptions {
  port?: number;
  /** open the page in the default browser (default true) */
  open?: boolean;
}

// `hotpath view <task>`: Vite dev server + /api/workflow serving the compiled
// workflow (re-read on every request so a recompile shows up on refresh).
export async function startViewer(
  task: string,
  options: ViewerOptions = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  await loadWorkflow(task); // fail fast, with the "run hotpath compile" hint
  const { createServer } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;

  const server = await createServer({
    root: viewerRoot,
    configFile: false,
    logLevel: "warn",
    plugins: [
      react(),
      {
        name: "hotpath-workflow-api",
        configureServer(s) {
          s.middlewares.use("/api/workflow", (_req, res) => {
            loadWorkflow(task).then(
              (workflow) => {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify(workflow));
              },
              (err: unknown) => {
                res.statusCode = 500;
                res.end(err instanceof Error ? err.message : String(err));
              },
            );
          });
        },
      },
    ],
    server: { port: options.port ?? 5173, host: "127.0.0.1" },
  });
  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === "object" && address ? address.port : 5173;
  const url = `http://127.0.0.1:${port}/`;
  if (options.open !== false) openBrowser(url);
  return { url, close: () => server.close() };
}

// Best effort (the URL is printed anyway). An argv, never a shell string.
function openBrowser(url: string): void {
  const [command, ...args] =
    process.platform === "win32"
      ? ["rundll32", "url.dll,FileProtocolHandler", url]
      : process.platform === "darwin"
        ? ["open", url]
        : ["xdg-open", url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => undefined); // no browser available
  child.unref();
}
