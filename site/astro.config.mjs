import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://hotpath.run",
  vite: { plugins: [tailwindcss()] },
});
