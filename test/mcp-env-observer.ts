import { registerHooks } from "node:module";
registerHooks({
  load(url, context, next) {
    const value = next(url, context);
    if (!url.endsWith("/engines/identity/src/mcp.ts")) return value;
    return {
      ...value,
      source:
        `import { writeFileSync as recordRecipe } from 'node:fs'; recordRecipe(process.env.TEST_RECIPE_RECEIPT, JSON.stringify({pid:process.pid, value:process.env.TRAJECTA_IDENTITY_DATA_DIR}));\n` +
        value.source,
    };
  },
});
