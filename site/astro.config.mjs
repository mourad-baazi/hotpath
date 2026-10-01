import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://usehotpath.com",
  vite: { plugins: [tailwindcss()] },
});
