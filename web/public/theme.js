// Applies the saved color theme before the page paints, so it never flashes
// the wrong one. Kept as a file (not inline) for the Content-Security-Policy.
(function () {
  try {
    var saved = localStorage.getItem('toretto:theme');
    var dark =
      saved === 'dark' ||
      (saved !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    root.classList.toggle('dark', dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
  } catch (e) {
    // Storage blocked: fall back to the light theme.
  }
})();
