// Template syntax (SPEC §5.2):
//   {{inputs.<name>}}
//   {{steps.<id>.result}}                    (whole result)
//   {{steps.<id>.result.<json.path>}}        (e.g. items.0.id)
//   {{steps.<id>.output}}                    (llm step text)
// A value that is exactly one template keeps its original type; anywhere else
// it's string interpolation (non-strings JSON-stringified).

export interface StepValues {
  result?: unknown;
  output?: string;
}

export interface TemplateContext {
  inputs: Record<string, unknown>;
  steps: Record<string, StepValues>;
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

function lookup(expr: string, ctx: TemplateContext): unknown {
  const parts = expr.trim().split(".");
  if (parts[0] === "inputs" && parts.length === 2) return ctx.inputs[parts[1]];
  if (parts[0] === "steps" && parts.length >= 3) {
    const step = ctx.steps[parts[1]];
    if (parts[2] === "output" && parts.length === 3) return step?.output;
    if (parts[2] === "result") {
      let value: unknown = step?.result;
      for (const p of parts.slice(3)) {
        value = child(value, p);
      }
      return value;
    }
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
