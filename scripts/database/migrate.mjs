import { applyMigrations, discoverPostgresTools } from "./lib.mjs";

const tools = await discoverPostgresTools();
await applyMigrations(tools, process.env);
console.log("all checked-in database migrations are applied");
