// ember-ui.js — the small amount of behaviour the standard controls need.
// Include once per page, after the markup:  <script src="…/ember-ui.js" defer></script>
//
// 1. Sliders: keeps --pct in step with the value so the filled part of the groove
//    paints (WebKit has no ::range-progress), and marks the current tick label.
//    Call EmberUI.sync(input) after changing a slider's value from code.
// 2. Segmented controls: one aria-pressed button per .e-seg, and a 'change' event.
// 3. Skins: inside [data-skin="glass"], marks each control as a flush-mounted glass
//    button (data-glass="button") for the glass shader; inside [data-skin="well"]
//    (or nowhere) removes the mark. Call EmberUI.skin(root) after changing data-skin
//    or adding controls. See the glass-skin section of ember-ui.css.
// 4. Tells the glass to redraw while a control is moving: 'ember:moved' on document.
(function () {
  function moved() { document.dispatchEvent(new Event('ember:moved')); }
  function glassy(el) { var s = el.closest('[data-skin]'); return !!s && s.dataset.skin === 'glass'; }

  function sync(el) {
    var min = +el.min || 0, max = +el.max || 100, v = +el.value;
    el.style.setProperty('--pct', ((v - min) / ((max - min) || 1)) * 100 + '%');
    var field = el.closest('.e-field');
    var ticks = field && field.querySelectorAll('.e-ticks span');
    if (ticks && ticks.length === Math.round((max - min) / (+el.step || 1)) + 1) {
      ticks.forEach(function (t, i) { t.setAttribute('aria-current', String(min + i * (+el.step || 1) === v)); });
    }
    moved();
  }

  function mark(el, on) {
    if (on) el.setAttribute('data-glass', 'button');
    else if (el.getAttribute('data-glass') === 'button') { el.removeAttribute('data-glass'); el.removeAttribute('data-glass-off'); }
  }

  function skin(root) {
    root = root || document;
    root.querySelectorAll('.e-btn').forEach(function (b) {
      // The white raised primary stays as it is unless the page gives it a tint.
      var plainPrimary = b.classList.contains('e-btn--primary') && !b.dataset.tint;
      mark(b, glassy(b) && !plainPrimary);
    });
    root.querySelectorAll('.e-seg button').forEach(function (b) {
      mark(b, glassy(b) && b.getAttribute('aria-pressed') === 'true');
    });
    root.querySelectorAll('.e-toggle > input + span').forEach(function (track) {
      var knob = track.querySelector('.e-glass-knob');
      if (glassy(track) && !knob) {
        knob = document.createElement('i'); knob.className = 'e-glass-knob';
        knob.setAttribute('data-glass', 'button'); knob.setAttribute('aria-hidden', 'true');
        track.appendChild(knob);
      } else if (!glassy(track) && knob) knob.remove();
    });
    // Sliders are the same in both skins: the thumb stays an opaque white object
    // (Blair, 2026-10-09: "the slider button needs to be opaque"). A clear glass thumb
    // on a thin groove was hard to find.
    moved();
  }

  function init(root) {
    (root || document).querySelectorAll('input.e-range').forEach(function (el) {
      if (el.__ember) return; el.__ember = true;
      el.addEventListener('input', function () { sync(el); });
      sync(el);
    });
    (root || document).querySelectorAll('.e-seg').forEach(function (seg) {
      if (seg.__ember) return; seg.__ember = true;
      seg.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b || !seg.contains(b)) return;
        seg.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        skin(seg);
        seg.dispatchEvent(new CustomEvent('change', { detail: { value: b.value || b.textContent.trim() } }));
      });
    });
    (root || document).querySelectorAll('.e-toggle input').forEach(function (inp) {
      if (inp.__ember) return; inp.__ember = true;
      inp.addEventListener('change', moved);
    });
    skin(root);
  }
  window.EmberUI = { init: init, sync: sync, skin: skin };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { init(); });
  else init();
})();
