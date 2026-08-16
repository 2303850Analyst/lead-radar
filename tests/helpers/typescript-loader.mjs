/**
 * Minimal test-only resolver for the Vite-style extensionless TypeScript imports
 * used by the application. Node 22.13+ strips erasable TypeScript syntax, but its
 * ESM resolver still requires an extension. Production code never uses this
 * loader.
 */
import { readFile } from "node:fs/promises";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return {
      url: new URL("./server-only-stub.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    const hasExtension = /\.[a-z0-9]+$/i.test(specifier);
    if (!isRelative || hasExtension || error?.code !== "ERR_MODULE_NOT_FOUND") {
      throw error;
    }

    for (const extension of [".ts", ".tsx", ".js", ".mjs"]) {
      try {
        return await nextResolve(`${specifier}${extension}`, context);
      } catch (candidateError) {
        if (candidateError?.code !== "ERR_MODULE_NOT_FOUND") throw candidateError;
      }
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".json")) {
    const source = await readFile(new URL(url), "utf8");
    return {
      format: "module",
      source: `export default ${source};`,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
