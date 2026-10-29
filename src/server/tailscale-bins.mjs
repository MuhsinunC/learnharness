// Where the Tailscale CLI may live: a GUI app's PATH rarely has it. One
// list for scripts/web-server.mjs (plain node) and web-login.ts.
export const TAILSCALE_BINS = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"];
