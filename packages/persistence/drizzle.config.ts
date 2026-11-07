export default {
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "../../db/migrations",
} as const;
