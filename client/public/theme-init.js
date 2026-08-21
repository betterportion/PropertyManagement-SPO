// Applies the saved theme before React paints, so there is no light/dark flash.
//
// This lives in its own file rather than inline in index.html so that the
// production Content Security Policy can forbid inline scripts outright
// (see server/security.ts). Keep the storage key in sync with
// client/src/providers/ThemeProvider.tsx.
(function () {
  var stored = null;
  try {
    stored = localStorage.getItem("spo-portal-theme");
  } catch (e) {
    /* private mode / storage disabled — fall back to following the device */
  }
  // Anything unrecognized means "follow the device", exactly as ThemeProvider decides.
  if (stored !== "light" && stored !== "dark") stored = "system";
  var prefersDark = false;
  try {
    prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch (e) {
    /* matchMedia unavailable */
  }
  var isDark = stored === "dark" || (stored === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", isDark);
  document.documentElement.style.colorScheme = isDark ? "dark" : "light";
})();
