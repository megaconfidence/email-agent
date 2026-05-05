import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import agents from "agents/vite";

/**
 * email-reply-parser's regex.js calls
 *   const require = createRequire(import.meta.url);
 *   try { this.RE2 = require("re2"); } catch {}
 * at module init to opt into Google's RE2 engine (a Node-only perf
 * optimization, not required for correctness — the lib falls back to
 * native RegExp). When bundled for Workers, `import.meta.url` is
 * undefined, so `createRequire(undefined)` throws on script validation
 * before the surrounding try/catch can run.
 *
 * We rewrite that one line to an always-failing stub, which preserves
 * the library's existing fallback behaviour.
 */
function patchEmailReplyParser(): Plugin {
  return {
    name: "patch-email-reply-parser",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("email-reply-parser") || !id.endsWith("regex.js")) {
        return null;
      }
      return code.replace(
        "const require = createRequire(import.meta.url);",
        "const require = () => { throw new Error('re2 unavailable in Workers'); };"
      );
    }
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
