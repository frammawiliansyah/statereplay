import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "express/index": "src/express/index.ts" },
  format: ["esm", "cjs"],
  external: ["express"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
});
