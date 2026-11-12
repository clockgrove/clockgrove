/// <reference types="vite/client" />

import { createRoot } from "react-dom/client";
import { localSessionAuthentication } from "./api.js";
import { ShellErrorBoundary } from "./recovery.js";
import { WorldApp } from "./scene.js";
import { worldShell } from "./shell.js";
import { WorldMcpAccess } from "./world-mcp-access.js";
import "./world-shell-tokens.css";
import "./world-shell.css";

for (const [name, value] of Object.entries(worldShell.tokens))
  document.documentElement.style.setProperty(name, value);

const element = document.getElementById("root");
if (!element) throw new Error("missing application root");
// Credentials are verified through the ordinary runtime authentication port, never in the browser.
createRoot(element).render(
  <ShellErrorBoundary>
    {["/mcp/tokens", "/mcp/consent", "/sign-in"].includes(location.pathname) ? (
      <WorldMcpAccess />
    ) : (
      <WorldApp authentication={localSessionAuthentication} />
    )}
  </ShellErrorBoundary>,
);
