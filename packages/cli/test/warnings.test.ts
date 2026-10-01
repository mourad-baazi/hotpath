import { describe, expect, it, vi } from "vitest";

import {
  installWarningFilter,
  isPunycodeWarning,
} from "../src/silence-warnings.js";

const PUNYCODE =
  "The `punycode` module is deprecated. Please use a userland alternative instead.";

describe("isPunycodeWarning", () => {
  it("recognizes the DEP0040 warning in every emitWarning call shape", () => {
    expect(isPunycodeWarning(PUNYCODE, "DeprecationWarning", "DEP0040")).toBe(
      true,
    );
    expect(
      isPunycodeWarning(PUNYCODE, {
        type: "DeprecationWarning",
        code: "DEP0040",
      }),
    ).toBe(true);
    expect(isPunycodeWarning(PUNYCODE)).toBe(true);
    const err = Object.assign(new Error(PUNYCODE), { code: "DEP0040" });
    expect(isPunycodeWarning(err)).toBe(true);
  });

  it("does not match other warnings", () => {
    expect(
      isPunycodeWarning(
        "Buffer() is deprecated",
        "DeprecationWarning",
        "DEP0005",
      ),
    ).toBe(false);
    expect(
      isPunycodeWarning("something experimental", "ExperimentalWarning"),
    ).toBe(false);
    expect(isPunycodeWarning(new Error("boom"))).toBe(false);
  });
});

describe("installWarningFilter", () => {
  it("drops the punycode deprecation but lets every other warning through", () => {
    const original = vi.fn();
    const target = { emitWarning: original } as unknown as NodeJS.Process;
    installWarningFilter(target);

    target.emitWarning(PUNYCODE, "DeprecationWarning", "DEP0040");
    expect(original).not.toHaveBeenCalled();

    target.emitWarning(
      "Buffer() is deprecated",
      "DeprecationWarning",
      "DEP0005",
    );
    expect(original).toHaveBeenCalledTimes(1);
    expect(original.mock.calls[0][0]).toBe("Buffer() is deprecated");
  });

  it("is idempotent (installing twice does not double-wrap)", () => {
    const original = vi.fn();
    const target = { emitWarning: original } as unknown as NodeJS.Process;
    installWarningFilter(target);
    installWarningFilter(target);
    target.emitWarning("other", "Warning");
    expect(original).toHaveBeenCalledTimes(1);
  });
});
