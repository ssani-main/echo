// Sets the theme token before first paint, so there is no flash of the
// wrong theme. Must stay a blocking script in <head> and must stay tiny.
// External rather than inline so the CSP can refuse inline script outright.
(function () {
  var saved = localStorage.getItem('echo-theme');
  var sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', saved || (sysDark ? 'dark' : 'light'));
})();
