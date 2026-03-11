import esbuild from "esbuild";
import process from "process";

const production = process.argv.includes("--production");

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*"],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js"
});

if (production) {
  await context.rebuild();
  await context.dispose();
  process.exit(0);
}

await context.watch();
console.log("Watching for changes...");
