import { createApp } from "./app.js";
import { config } from "./config.js";

const app = await createApp();
await app.listen(config.port, "0.0.0.0");
console.log(`API escuchando en ${config.baseUrl}`);
