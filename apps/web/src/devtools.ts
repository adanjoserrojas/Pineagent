// Developer and test conveniences (?as= sign-in, ?api= override, window hooks, mock hints).
// On in the dev server and in `vite build --mode development` (what e2e serves); off in a
// production build. import.meta.env.DEV alone is false in every built bundle, so the mode decides.
export const DEV_TOOLS = import.meta.env.MODE !== "production";
