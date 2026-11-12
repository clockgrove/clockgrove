import { sha256Hex } from "@clockgrove/kernel";
import { MCP_READ_LIMITS } from "./mcp-execution.js";

/** SHA-256 of UTF-8 JSON, sorting object keys recursively and preserving array order. */
export function mcpReadArgumentsHash(value: unknown): string {
  let nodes = 0;
  const encode = (item: unknown, depth: number): string => {
    if (++nodes > MCP_READ_LIMITS.nodes || depth > MCP_READ_LIMITS.depth)
      throw new Error("Invalid effect arguments");
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    )
      return JSON.stringify(item);
    if (Array.isArray(item)) {
      if (
        Reflect.ownKeys(item).length !== item.length + 1 ||
        Object.keys(item).length !== item.length ||
        Object.keys(item).some((key, index) => key !== String(index))
      )
        throw new Error("Invalid effect arguments");
      return `[${item.map((child) => encode(child, depth + 1)).join(",")}]`;
    }
    if (
      typeof item !== "object" ||
      item === null ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(item))
    )
      throw new Error("Invalid effect arguments");
    const keys = Object.keys(item).sort();
    if (Reflect.ownKeys(item).length !== keys.length) throw new Error("Invalid effect arguments");
    if (keys.some((key) => ["__proto__", "prototype", "constructor"].includes(key)))
      throw new Error("Invalid effect arguments");
    return `{${keys.map((key) => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
  };
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid effect arguments");
  const bytes = new TextEncoder().encode(encode(value, 0));
  if (bytes.length > MCP_READ_LIMITS.argumentBytes) throw new Error("Invalid effect arguments");
  return sha256Hex(bytes);
}
