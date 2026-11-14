// Template syntax (SPEC §5.2):
//   {{inputs.<name>}}
//   {{steps.<id>.result}}                    (whole result)
//   {{steps.<id>.result.<json.path>}}        (e.g. items.0.id)
//   {{steps.<id>.output}}                    (llm step text)
//   {{steps.<id>.results}}                   (foreach: per-item results)
//   {{<as>.<json.path>}}                     (foreach body: the current item)
// Loop body ids contain a dot (s3.1); `steps.s3.1.result` resolves to them.
// A value that is exactly one template keeps its original type; anywhere else
// it's string interpolation (non-strings JSON-stringified).

export interface StepValues {
  result?: unknown;
  output?: string;
  results?: unknown[];
}

export interface TemplateContext {
  inputs: Record<string, unknown>;
  steps: Record<string, StepValues>;
  /** loop variables (foreach `as`) in scope */
  vars?: Record<string, unknown>;
}

const TEMPLATE_RE = /\{\{([^{}]+)\}\}/g;

export function renderTemplate(value: unknown, ctx: TemplateContext): unknown {
  if (typeof value === "string") return renderString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => renderTemplate(v, ctx));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, renderTemplate(v, ctx)]),
    );
  }
  return value;
}

function renderString(text: string, ctx: TemplateContext): unknown {
  const matches = [...text.matchAll(TEMPLATE_RE)];
  if (
    matches.length === 1 &&
    matches[0].index === 0 &&
    matches[0][0].length === text.length
  ) {
    return lookup(matches[0][1], ctx);
  }
  return text.replace(TEMPLATE_RE, (_m, expr: string) => {
    const value = lookup(expr, ctx);
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

/** Resolve one reference such as `steps.s1.result.emails.0.subject` (no braces). */
export function lookupReference(expr: string, ctx: TemplateContext): unknown {
  return lookup(expr, ctx);
}

function walk(value: unknown, path: string[]): unknown {
  for (const p of path) value = child(value, p);
  return value;
}

function lookup(expr: string, ctx: TemplateContext): unknown {
  const parts = expr.trim().split(".");
  if (parts[0] === "inputs" && parts.length === 2) return ctx.inputs[parts[1]];
  if (parts[0] === "steps" && parts.length >= 3) {
    // extend the id over numeric segments while such a step exists (s3.1)
    let id = parts[1];
    let i = 2;
    while (
      i < parts.length - 1 &&
      /^\d+$/.test(parts[i]) &&
      `${id}.${parts[i]}` in ctx.steps
    ) {
      id = `${id}.${parts[i]}`;
      i++;
    }
    const step = ctx.steps[id];
    const field = parts[i];
    if (field === "output" && i === parts.length - 1) return step?.output;
    if (field === "result") return walk(step?.result, parts.slice(i + 1));
    if (field === "results") return walk(step?.results, parts.slice(i + 1));
    return undefined;
  }
  if (ctx.vars && Object.hasOwn(ctx.vars, parts[0])) {
    return walk(ctx.vars[parts[0]], parts.slice(1));
  }
  return undefined;
}

function child(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return value[Number(key)];
  if (value !== null && typeof value === "object") {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}
