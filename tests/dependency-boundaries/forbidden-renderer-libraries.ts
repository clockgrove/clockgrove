// Paths into apps/web's installed packages resolve, so the rule must match resolved node_modules edges.

import type { ReactNode } from "../../apps/web/node_modules/@types/react";
import type { Game } from "../../apps/web/node_modules/phaser";
import { createRoot } from "../../apps/web/node_modules/react-dom/client";

export type ForbiddenRenderer = Game | ReactNode;
export const forbiddenRendererLibraries = [createRoot];
