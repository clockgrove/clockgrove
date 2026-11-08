// Paths into apps/web's installed packages resolve, so the rule must match resolved node_modules edges.

import type { ReactNode } from "../../apps/web/node_modules/@types/react";
import type { Mesh } from "../../apps/web/node_modules/@types/three";
import { createRoot } from "../../apps/web/node_modules/react-dom/client";
import { WebGLRenderer } from "../../apps/web/node_modules/three";
import type { Game } from "../../spikes/renderer-bakeoff/node_modules/phaser";

export type ForbiddenRenderer = Game | ReactNode | Mesh;
export const forbiddenRendererLibraries = [createRoot, WebGLRenderer];
