/* Sidereal 作品主题 · 深浅切换（v1，2026-10-09）
   三档：跟随系统 / 浅 / 深。全站共用 localStorage 键 sidereal-theme：在一件作品里切换，其他作品打开时也跟着变，
   已经打开的标签页和网页库里的阅读框通过 storage 事件同步。
   必须放在 <head> 里、样式表之前，同步执行，避免先白闪一下：
   <script src="../_theme/sidereal.js"></script>（相对路径按作品所在层级写，检查脚本会核对） */
(function () {
  var KEY = 'sidereal-theme', MODES = ['system', 'light', 'dark'], LABEL = { system: '跟随系统', light: '浅色', dark: '深色' };
  var root = document.documentElement, mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  function mode() { try { var m = localStorage.getItem(KEY); return MODES.indexOf(m) >= 0 ? m : 'system'; } catch (e) { return 'system'; } }
  function label() {
    var m = mode(), list = document.querySelectorAll('[data-sd-theme]');
    for (var i = 0; i < list.length; i++) { list[i].textContent = LABEL[m]; list[i].setAttribute('data-mode', m); list[i].setAttribute('aria-label', '深浅色：' + LABEL[m] + '，点按切换'); list[i].setAttribute('title', '深浅色：' + LABEL[m]); }
  }
  function apply() {
    var m = mode(), dark = m === 'dark' || (m === 'system' && mq && mq.matches);
    root.setAttribute('data-theme-mode', m); root.setAttribute('data-theme', dark ? 'dark' : 'light'); label();
    try { root.dispatchEvent(new CustomEvent('sd-theme', { detail: { mode: m, theme: dark ? 'dark' : 'light' } })); } catch (e) {}
  }
  function set(m) { if (MODES.indexOf(m) < 0) m = 'system'; try { localStorage.setItem(KEY, m); } catch (e) {} apply(); }
  function next() { var m = mode(); set(MODES[(MODES.indexOf(m) + 1) % MODES.length]); }
  apply();
  if (mq) { if (mq.addEventListener) mq.addEventListener('change', apply); else if (mq.addListener) mq.addListener(apply); }
  window.addEventListener('storage', function (e) { if (e.key === KEY) apply(); });
  document.addEventListener('click', function (e) { var t = e.target, b = t && t.closest ? t.closest('[data-sd-theme]') : null; if (b) { e.preventDefault(); next(); } });
  function ready() {
    if (root.getAttribute('data-sd-toggle') === 'auto' && !document.querySelector('[data-sd-theme]')) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'sd-theme-fab'; b.setAttribute('data-sd-theme', ''); document.body.appendChild(b);
    }
    label();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
  window.SiderealTheme = { get: mode, set: set, next: next };
})();
