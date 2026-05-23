import typography from "@tailwindcss/typography";

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          base: "rgb(var(--bg-base) / <alpha-value>)",
          panel: "rgb(var(--bg-panel) / <alpha-value>)",
          panelAlt: "rgb(var(--bg-panel-alt) / <alpha-value>)",
          hover: "rgb(var(--bg-hover) / <alpha-value>)",
          active: "rgb(var(--bg-active) / <alpha-value>)",
        },
        border: {
          subtle: "rgb(var(--border-subtle) / <alpha-value>)",
        },
        fg: {
          primary: "rgb(var(--fg-primary) / <alpha-value>)",
          secondary: "rgb(var(--fg-secondary) / <alpha-value>)",
          muted: "rgb(var(--fg-muted) / <alpha-value>)",
        },
      },
    },
  },
  plugins: [typography],
};
