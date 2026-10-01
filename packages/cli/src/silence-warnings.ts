// A dependency still does `require("punycode")`, which makes Node print
//   (node:1234) [DEP0040] DeprecationWarning: The `punycode` module is deprecated…
// on stderr of every command (and of the MCP proxy the agent launches). It is
// not actionable for users, so hide that one warning; all others still show.
// This module must be imported before anything that loads the dependency.

type EmitWarning = NodeJS.Process["emitWarning"];

const INSTALLED = Symbol.for("hotpath.warningFilterInstalled");

/** True for the DEP0040 warning, whatever shape emitWarning was called in. */
export function isPunycodeWarning(
  warning: unknown,
  ...rest: unknown[]
): boolean {
  const options = rest.find((a) => a !== null && typeof a === "object") as
    { code?: string } | undefined;
  const code =
    options?.code ??
    rest.find((a) => typeof a === "string" && /^DEP\d+$/.test(a)) ??
    (warning as { code?: string } | undefined)?.code;
  if (code === "DEP0040") return true;
  const message =
    typeof warning === "string"
      ? warning
      : (warning as Error | undefined)?.message;
  return typeof message === "string" && /punycode/i.test(message);
}

export function installWarningFilter(target: NodeJS.Process = process): void {
  const marked = target as unknown as Record<symbol, boolean>;
  if (marked[INSTALLED]) return;
  marked[INSTALLED] = true;
  const original = target.emitWarning.bind(target) as EmitWarning;
  target.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    if (isPunycodeWarning(warning, ...rest)) return;
    return (original as (...args: unknown[]) => void)(warning, ...rest);
  }) as EmitWarning;
}

installWarningFilter();
