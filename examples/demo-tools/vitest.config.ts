import { defineConfig } from "vitest/config";

// Both test files write out/messages.json through the real servers.
export default defineConfig({ test: { fileParallelism: false } });
