/*
 * The sessions drawer's media query (LH-44, LH-56), in its own module so
 * the e2e suite reads the same string the sidebar uses. In the browser
 * the sidebar is a drawer under 640px, and under 1024px (Tailwind's lg)
 * on a touch screen; a mouse-driven window from 640px up keeps the inline
 * sidebar. max-width rather than range syntax keeps this one rule
 * independent of range-query support (the build itself targets Safari
 * 16.4 and up).
 */
export const COMPACT_QUERY = "(max-width: 39.98rem), (max-width: 63.98rem) and (pointer: coarse)";
