// Day or night, before the page is drawn (a plain script in <head>): what this browser chose with
// the button at the top left, else what the computer is set to. topbar-boot.js runs the button.
(function () {
  var t = null;
  try { t = localStorage.getItem('theme'); } catch (e) { /* no storage */ }
  if (t !== 'light' && t !== 'dark') {
    t = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', t);

  // The tab icon in the mode's colours, like the logo in the top bar: space-coloured by day (dark on a
  // light tab), moon-coloured at night (light on a dark tab). The day / night button calls it again.
  // The links are replaced rather than changed: some browsers only notice a new <link>.
  window.setFavicon = function (theme) {
    var name = theme === 'light' ? 'space' : 'moon';
    var links = document.querySelectorAll('link[rel="icon"][sizes]');
    for (var i = 0; i < links.length; i++) {
      var size = links[i].getAttribute('sizes').split('x')[0];
      var href = 'favicon-' + name + '-' + size + '.png';
      if (links[i].getAttribute('href') === href) continue;
      var link = links[i].cloneNode();
      link.setAttribute('href', href);
      links[i].parentNode.replaceChild(link, links[i]);
    }
  };
  window.setFavicon(t);
})();
