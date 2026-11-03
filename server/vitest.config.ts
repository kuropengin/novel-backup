import { defineConfig } from "vitest/config";

export default defineConfig({
  // bcrypt のコストはテストでは低くして高速化(password.ts の targetCost 参照)
  test: { include: ["test/**/*.test.ts"], environment: "node", env: { BCRYPT_COST: "4" } },
});
