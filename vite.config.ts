import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import type { Plugin as RolldownPlugin } from "rolldown";
import agents from "agents/vite";

// email-reply-parser opts into the Node-only `re2` engine via `require("re2")`,
// which can't resolve in the Workers runtime. Rewriting that require to throw
// keeps the library on its native-RegExp fallback (it already catches it).
function rewriteRe2Require(code: string, id: string) {
  if (!id.includes("email-reply-parser") || !id.endsWith("regex.js")) {
    return null;
  }
  return code.replace(
    "const require = createRequire(import.meta.url);",
    "const require = () => { throw new Error('re2 unavailable in Workers'); };"
  );
}

function patchEmailReplyParser(): Plugin {
  // The build runs the Vite `transform` hook below; the dev dependency
  // optimizer (Rolldown) needs the rewrite registered as its own plugin.
  const optimizeStub: RolldownPlugin = {
    name: "patch-email-reply-parser-optimize",
    transform: (code, id) => rewriteRe2Require(code, id) ?? undefined
  };
  return {
    name: "patch-email-reply-parser",
    enforce: "pre",
    configEnvironment(name, options) {
      if (name === "client") return;
      options.optimizeDeps ??= {};
      options.optimizeDeps.rolldownOptions ??= {};
      const existing = options.optimizeDeps.rolldownOptions.plugins;
      options.optimizeDeps.rolldownOptions.plugins = [
        ...(Array.isArray(existing) ? existing : []),
        optimizeStub
      ];
    },
    transform: (code, id) => rewriteRe2Require(code, id)
  };
}

export default defineConfig({
  plugins: [
    patchEmailReplyParser(),
    agents(),
    react(),
    cloudflare(),
    tailwindcss()
  ]
});
