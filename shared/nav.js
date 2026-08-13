(function () {
  var me = document.currentScript || document.querySelector('script[src$="nav.js"]');
  var root = (me && me.getAttribute('data-root')) || '.';
  var tabs = [
    { label: 'Home',        seg: '',        path: root + '/' },
    { label: 'Review',      seg: 'review',  path: root + '/review/' },
    { label: 'OA Builder',  seg: 'oar',     path: root + '/oar/' },
    { label: 'First-Print', seg: 'print',   path: root + '/print/' },
    { label: 'Text Extract', seg: 'text-from-docx', path: root + '/text-from-docx/' },
    { label: 'Paper',       seg: 'paper',   path: root + '/paper/Patent_Review_Bot.pdf', external: true }
  ];
  var current = '';
  if (/\/review\//.test(location.pathname)) current = 'review';
  else if (/\/oar\//.test(location.pathname)) current = 'oar';
  else if (/\/print\//.test(location.pathname)) current = 'print';
  else if (/\/text-from-docx\//.test(location.pathname)) current = 'text-from-docx';

  var css =
    '.suite-nav{position:sticky;top:0;width:100%;display:flex;gap:0.25rem;' +
    'justify-content:center;background:#0b0b0b;border-bottom:1px solid #2e2e2e;' +
    'padding:0.6rem 1rem;z-index:1000;font-family:Georgia,"Times New Roman",serif;}' +
    '.suite-nav a{color:#8a8580;text-decoration:none;font-size:0.8rem;' +
    'letter-spacing:0.08em;text-transform:uppercase;padding:0.35rem 0.9rem;' +
    'border-radius:2px;transition:color 0.15s,background 0.15s;}' +
    '.suite-nav a:hover{color:#e8e4dc;background:#1f1f1f;}' +
    '.suite-nav a.active{color:#6b8cba;border-bottom:2px solid #6b8cba;}';
  var style = document.createElement('style');
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  function build() {
    if (document.querySelector('.suite-nav')) return;
    var nav = document.createElement('nav');
    nav.className = 'suite-nav';
    tabs.forEach(function (t) {
      var a = document.createElement('a');
      a.href = t.path;
      a.textContent = t.label;
      if (t.external) { a.target = '_blank'; a.rel = 'noopener'; }
      if (t.seg === current) a.className = 'active';
      nav.appendChild(a);
    });
    document.body.insertBefore(nav, document.body.firstChild);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
