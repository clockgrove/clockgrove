/// <reference types="vite/client" />
import { createRoot } from "react-dom/client";
import { localSessionAuthentication } from "./api.js";
import { RaccoonWorldApp } from "./yard.js";
import "./raccoon-world.css";

const element = document.getElementById("root");
if (!element) throw new Error("missing application root");
// Credentials are verified through the ordinary runtime authentication port, never in the browser.
createRoot(element).render(<RaccoonWorldApp authentication={localSessionAuthentication} />);
