export const THEMES = [
  {
    id: "dark",
    name: "Graphite",
    description: "Graphite & signal lime",
    colors: ["#1c1c1c", "#37383a", "#c8f56b"],
  },
  {
    id: "light",
    name: "Paper light",
    description: "Crisp & spacious",
    colors: ["#f7f8f5", "#e8ebe3", "#416514"],
  },
  {
    id: "midnight",
    name: "Midnight",
    description: "Ink & periwinkle",
    colors: ["#111827", "#263449", "#b6bfff"],
  },
  {
    id: "forest",
    name: "Forest",
    description: "Pine & soft sage",
    colors: ["#14201c", "#2c4036", "#a9d9b4"],
  },
  {
    id: "contrast",
    name: "High contrast",
    description: "Black & bright amber",
    colors: ["#080808", "#242424", "#ffdb70"],
  },
  {
    id: "system",
    name: "System",
    description: "Follow your device",
    colors: ["#1c1c1c", "#f7f8f5", "#c8f56b"],
  },
] as const;
export type Theme = (typeof THEMES)[number]["id"];
export const isTheme = (value: unknown): value is Theme => THEMES.some((theme) => theme.id === value);
