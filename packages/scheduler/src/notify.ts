import crossSpawn from "cross-spawn";
import { readFile } from "node:fs/promises";

import {
  hotpathConfigSchema,
  type HotpathConfig,
  type RunRecord,
} from "hotpath-shared";

import { statePaths } from "./paths.js";

export interface Notification {
  title: string;
  body: string;
  /** JSON sent to the webhook */
  payload: {
    task: string;
    status: RunRecord["status"];
    reason: string;
    scheduleId: string | null;
    startedAt: string;
    inspect: string;
  };
}

export async function loadConfig(stateDir: string): Promise<HotpathConfig> {
  const file = statePaths(stateDir).config;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return {};
  }
  try {
    return hotpathConfigSchema.parse(JSON.parse(text));
  } catch (err) {
    throw new Error(
      `${file} is not valid (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) — ` +
        'expected {"notify": {"desktop": true, "webhook": "https://…"}}',
    );
  }
}

// Reasons can quote tool output; keep them short and on one line so a
// notification never carries a whole result (or a secret inside one).
function shortReason(error: string | undefined): string {
  const oneLine = (error ?? "no reason recorded").replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 197)}…` : oneLine;
}

/** Only drift and failed runs notify. */
export function buildNotification(run: RunRecord): Notification | null {
  if (run.status !== "drift" && run.status !== "failed") return null;
  const reason = shortReason(run.error);
  const inspect = `hotpath runs --task ${run.task}`;
  return {
    title: `Hotpath: ${run.task} ${run.status === "drift" ? "drifted" : "failed"}`,
    body: `${reason}\nInspect: ${inspect}`,
    payload: {
      task: run.task,
      status: run.status,
      reason,
      scheduleId: run.scheduleId,
      startedAt: run.startedAt,
      inspect,
    },
  };
}

export type DesktopNotifier = (title: string, body: string) => Promise<void>;

/**
 * Desktop notification with the OS's own tool, no extra dependency: the text is
 * always passed as separate arguments or environment values, never inside a
 * script string, so nothing in it can be executed.
 */
export const osDesktopNotifier: DesktopNotifier = (title, body) => {
  let command: string;
  let args: string[];
  const env = { ...process.env };
  if (process.platform === "darwin") {
    command = "osascript";
    args = [
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e",
      "end run",
      title,
      body,
    ];
  } else if (process.platform === "win32") {
    command = "powershell.exe";
    env.HOTPATH_TITLE = title;
    env.HOTPATH_BODY = body;
    args = [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
        "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
        "$x = $t.GetElementsByTagName('text')",
        "$x.Item(0).AppendChild($t.CreateTextNode($env:HOTPATH_TITLE)) > $null",
        "$x.Item(1).AppendChild($t.CreateTextNode($env:HOTPATH_BODY)) > $null",
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Hotpath').Show([Windows.UI.Notifications.ToastNotification]::new($t))",
      ].join("; "),
    ];
  } else {
    command = "notify-send";
    args = ["--app-name=Hotpath", title, body];
  }
  return new Promise((resolve, reject) => {
    const child = crossSpawn(command, args, { env, stdio: "ignore" });
    child.on("error", (err) =>
      reject(new Error(`${command} is not available: ${err.message}`)),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with code ${code}`)),
    );
  });
};

/** POST JSON with a 5s timeout; one retry on a network error or 5xx, never more. */
export async function postWebhook(
  url: string,
  payload: unknown,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
      if (res.status < 500) break; // the receiver rejected it; retrying won't help
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`webhook failed: ${lastError}`);
}

export interface NotifyDeps {
  desktop?: DesktopNotifier;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

/** Sends the run's notification to every configured channel. Never throws. */
export async function notifyRun(
  config: HotpathConfig,
  run: RunRecord,
  deps: NotifyDeps = {},
): Promise<void> {
  const note = buildNotification(run);
  if (!note) return;
  const log = deps.log ?? ((m: string) => console.error(m));
  const jobs: Promise<void>[] = [];
  if (config.notify?.desktop) {
    jobs.push(
      (deps.desktop ?? osDesktopNotifier)(note.title, note.body).catch((err) =>
        log(`[notify] desktop notification failed: ${(err as Error).message}`),
      ),
    );
  }
  if (config.notify?.webhook) {
    jobs.push(
      postWebhook(config.notify.webhook, note.payload, deps.fetch).catch(
        (err) => log(`[notify] ${(err as Error).message}`),
      ),
    );
  }
  await Promise.all(jobs);
}
