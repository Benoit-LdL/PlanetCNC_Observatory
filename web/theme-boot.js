// Day or night, before the page is drawn (a plain script in <head>): what this browser chose with
// the button at the top left, else what the computer is set to. topbar-boot.js runs the button.
(function () {
  var t = null;
  try { t = localStorage.getItem('theme'); } catch (e) { /* no storage */ }
  if (t !== 'light' && t !== 'dark') {
    t = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', t);
})();
