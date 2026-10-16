import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    files: ["packages/studio/src/**/*.{js,mjs,cjs,jsx}", "components/**/*.{js,jsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      "react-hooks/rules-of-hooks": "warn",
      "react-hooks/exhaustive-deps": "warn",
      "no-undef": "off",
      "no-unused-vars": "off",
    },
  },
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "packages/core/**",
      "packages/repurpose-engine/**",
      "packages/vfx-engine/**",
      "packages/animation-engine/**",
      "release/**",
      ".tmp/**",
      "My Stuff and Tests/**",
      "output/**",
    ],
  },
];
