import js from "@eslint/js";
import globals from "globals";

export default [
    { ignores: ["build/**", "playwright-report/**", "test-results/**"] },
    js.configs.recommended,
    {
        files: ["assets/**/*.js"],
        languageOptions: { globals: globals.browser },
    },
    {
        files: ["tests/frontend/**/*.js", "*.config.js"],
        languageOptions: { globals: { ...globals.node, ...globals.browser } },
    },
];
