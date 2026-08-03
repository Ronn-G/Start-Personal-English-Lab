import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/component/setup.ts"],
    include: ["test/component/**/*.test.tsx"],
    clearMocks: true,
    restoreMocks: true,
  },
});
