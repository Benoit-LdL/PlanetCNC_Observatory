// Day or night, before the page is drawn (a plain script in <head>): what this browser chose with
// the logo at the top left (the switch), else what the computer is set to. topbar-boot.js runs the switch.
(function () {
  var t = null;
  try { t = localStorage.getItem('theme'); } catch (e) { /* no storage */ }
  if (t !== 'light' && t !== 'dark') {
    t = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', t);
})();
