// three ships no type declarations; the spike types it loosely instead of adding @types/three's
// dependency tree to a throwaway package (issue 67 plan, assumption 3).
declare module "three";
declare module "three/webgpu";
declare module "three/tsl";
declare module "three/addons/*";
declare module "three/examples/jsm/*";
