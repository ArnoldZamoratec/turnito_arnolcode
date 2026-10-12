import { defineConfig } from "astro/config";

// Sitio estático: se publica en Cloudflare Pages sin servidor.
export default defineConfig({
  site: "https://turnito.pe",
  output: "static",
});
