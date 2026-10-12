// Time scrubber + date picker.
//
// In sun mode the slider runs 0..1439 (minutes of local day).
// In moon mode the slider runs 0..(set - rise in minutes), with the value
// representing the number of minutes after the active moonrise — so the
// left edge = moonrise and the right edge = moonset.

import * as store from '../state.js';
import { withMinutes, minutesOfDay, startOfLocalDay, formatDate, throttleRaf } from '../util.js';

let scrubberRange = { mode: 'sun', moonRise: null, moonSet: null };
let dateLabelEl = null;

export function setScrubberRange(els, mode, moonRise = null, moonSet = null) {
  scrubberRange = { mode, moonRise, moonSet };
  // The day-level recompute that calls this (app.js redraw) runs AFTER the
  // 'datetime' subscriber below, so the date label needs its own refresh here
  // too — otherwise jumping to a new day (date picker, mode toggle, locate)
  // shows the label computed against the previous day's moonrise/set.
  refreshDateLabel();
  if (!els || !els.scrubber) return;
  if (mode === 'moon' && moonRise && moonSet && moonSet > moonRise) {
    const span = Math.max(1, Math.round((moonSet - moonRise) / 60000));
    els.scrubber.min = '0';
    els.scrubber.max = String(span);
    els.scrubber.step = '1';
  } else {
    els.scrubber.min = '0';
    els.scrubber.max = '1439';
    els.scrubber.step = '1';
  }
}

function refreshDateLabel() {
  if (dateLabelEl) dateLabelEl.textContent = dateLabelText(store.get().datetime);
}

// Moon mode is framed around the moonrise EVENT, not the calendar date the
// scrub position happens to land on — a single rise→set arc commonly crosses
// midnight, so a plain calendar date silently flips mid-scrub and reads as a
// different night than the one you're actually looking at. Anchoring the
// label to the arc's moonrise night and phrasing it relative to today removes
// that ambiguity at the source.
function dateLabelText(d) {
  if (scrubberRange.mode === 'moon' && scrubberRange.moonRise) {
    return describeMoonNight(scrubberRange.moonRise, new Date());
  }
  return formatDate(startOfLocalDay(d));
}

function describeMoonNight(moonRise, now) {
  const dayDiff = Math.round((startOfLocalDay(moonRise) - startOfLocalDay(now)) / 86400000);
  if (dayDiff === 0) return 'Tonight';
  if (dayDiff === -1) return 'Last night';
  if (dayDiff === 1) return 'Tomorrow night';
  const nights = Math.abs(dayDiff);
  const suffix = dayDiff < 0 ? `${nights} nights ago` : `in ${nights} nights`;
  return `${formatDate(moonRise)} (${suffix})`;
}

export function initScrubber(els) {
  const { scrubber, hh, dateBtn, dateLabel, dateInput } = els;
  dateLabelEl = dateLabel;

  const apply = throttleRaf(() => {
    const v = +scrubber.value;
    let d;
    if (scrubberRange.mode === 'moon' && scrubberRange.moonRise) {
      d = new Date(scrubberRange.moonRise.getTime() + v * 60000);
    } else {
      d = withMinutes(store.get().datetime, v);
    }
    store.set({ datetime: d });
    hh.textContent = formatHHMM(d);
  });
  scrubber.addEventListener('input', apply);

  // Default scrubber to current time
  scrubber.value = String(minutesOfDay(store.get().datetime));
  hh.textContent = formatHHMM(store.get().datetime);

  // dateBtn is a <label for="date-input">. Mobile opens the picker via native
  // label activation, but on desktop a label only FOCUSES the input — the
  // calendar doesn't pop, which read as "unreliable on PC". So when the browser
  // supports it, open the picker explicitly with showPicker() and suppress the
  // implicit label focus; otherwise fall through to native label activation.
  if (dateBtn) {
    dateBtn.addEventListener('click', (e) => {
      if (typeof dateInput.showPicker === 'function') {
        e.preventDefault();
        try { dateInput.showPicker(); } catch { try { dateInput.focus(); } catch {} }
      }
    });
  }
  dateInput.addEventListener('change', () => {
    if (!dateInput.value) return;
    const [y, m, d] = dateInput.value.split('-').map(Number);
    const cur = store.get().datetime;
    const newDate = new Date(cur);
    newDate.setFullYear(y, m - 1, d);
    store.set({ datetime: newDate });
  });

  store.subscribe('datetime', (d) => {
    let v;
    if (scrubberRange.mode === 'moon' && scrubberRange.moonRise) {
      v = Math.round((d - scrubberRange.moonRise) / 60000);
    } else {
      v = minutesOfDay(d);
    }
    if (+scrubber.value !== v) scrubber.value = String(v);
    hh.textContent = formatHHMM(d);
    dateLabel.textContent = dateLabelText(d);
    const isoDate = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    dateInput.value = isoDate;
  });

  dateLabel.textContent = dateLabelText(store.get().datetime);
}

export function renderScrubberTicks(ticksEl, rise, set, day) {
  if (!ticksEl) return;
  ticksEl.innerHTML = '';
  if (!day) return;

  if (scrubberRange.mode === 'moon' && scrubberRange.moonRise && scrubberRange.moonSet) {
    // In moon mode the slider IS rise→set, so left tick = 0% and right tick = 100%
    addTick(ticksEl, 0, 'sunrise');
    addTick(ticksEl, 100, 'sunset');
    return;
  }
  const dayStart = startOfLocalDay(day).getTime();
  const dayMs = 86400000;
  const make = (date, cls) => {
    if (!date) return;
    const offset = date.getTime() - dayStart;
    if (offset < 0 || offset > dayMs) return;
    addTick(ticksEl, (offset / dayMs) * 100, cls);
  };
  make(rise, 'sunrise');
  make(set, 'sunset');
}

function addTick(ticksEl, pct, cls) {
  const t = document.createElement('div');
  t.className = 'tick ' + cls;
  t.style.left = `${pct.toFixed(2)}%`;
  ticksEl.appendChild(t);
}

function pad(n) { return String(n).padStart(2, '0'); }

function formatHHMM(d) {
  if (!(d instanceof Date)) {
    const m = Math.round(d);
    const h = Math.floor(m / 60) % 24;
    const mm = m % 60;
    return `${pad(h)}:${pad(mm)}`;
  }
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}


// ── The track's day ramp ─────────────────────────────────────────────────────
//
// 2026-09-15, Blair: "the light/dark gradient on the line it slides along only
// goes to noon, after that it's just a grey line."
//
// Two things were wrong and only one of them was the mask.
//
// 1. The ramp was MASKED to the thumb position. That was deliberate (2026-07-29,
//    "make the thumb read as the end of a line it is extending") and it is right
//    for the elevation sliders, where the track is a QUANTITY and the part past
//    the thumb is genuinely not selected. It is wrong here, because this track
//    is not a progress bar — it is a picture of the day, and the part past the
//    thumb is the part you have not got to yet. Hiding it threw away the only
//    at-a-glance answer to "how much daylight is left". The ramp is now drawn
//    full width, dimmed past the thumb rather than erased, so it still reads as
//    a line being extended AND still shows the whole day.
//
// 2. The stops were HARDCODED at 10/24/50/76/90 per cent, which is a day that
//    rises at 02:24 and sets at 18:14 and is never any other length. In Toronto
//    that is wrong by up to three hours either side depending on the month. The
//    stops now come from the real sunrise, sunset, golden hours and twilight
//    bands for the day and place being shown, so the track is a genuine picture
//    of THAT day's light — and the ramp visibly stretches and shrinks as you
//    move through the year, which is the app's whole subject.
const RAMP = {
  night:   '#05070f',
  astro:   '#0a1024',
  civil:   '#1d3160',
  gold:    '#ffb845',
  day:     '#ffe9b0',
};

const _pctOfDay = (d, dayStart) => {
  if (!d) return null;
  const m = (d.getTime() - dayStart) / 60000;
  return Math.max(0, Math.min(100, (m / 1439) * 100));
};

/**
 * Build the time-of-day gradient for the scrubber track from real solar events.
 * `b` is the object returned by solar.getDayBoundaries(). Missing events (polar
 * day, polar night, a latitude with no civil dawn in midsummer) simply drop out
 * of the stop list, which degrades to a flat colour rather than throwing.
 */
export function paintScrubberDayRamp(els, mode, b, datetime) {
  const wrap = els && els.scrubberWrap;
  if (!wrap) return;

  if (mode === 'moon') {
    // The moon track is not a day — it runs moonrise to moonset — so a solar
    // ramp on it would be a decoration that lies. Flat moonlight instead.
    wrap.style.setProperty('--day-ramp',
      'linear-gradient(90deg, #0a1024 0%, #6f86c9 50%, #0a1024 100%)');
    return;
  }

  const dayStart = startOfLocalDay(datetime).getTime();
  const at = (d) => _pctOfDay(d, dayStart);
  const stops = [];
  const push = (pct, col) => { if (pct !== null && isFinite(pct)) stops.push([pct, col]); };

  push(0, RAMP.night);
  push(at(b.astronomicalDawn), RAMP.astro);
  push(at(b.civilDawn), RAMP.civil);
  push(at(b.sunrise), RAMP.gold);
  push(at(b.goldenHourMorningEnd), RAMP.day);
  push(at(b.goldenHourEveningStart), RAMP.day);
  push(at(b.sunset), RAMP.gold);
  push(at(b.civilDusk), RAMP.civil);
  push(at(b.astronomicalDusk), RAMP.astro);
  push(100, RAMP.night);

  // A gradient whose stops run backwards renders as a hard edge, and the events
  // CAN come back out of order — a polar summer has no astronomical dawn but
  // does have a civil one, and SunCalc returns Invalid Date for the missing
  // ones, which `at` turns into null but which can still leave neighbours
  // crossed. Sorting is one line and removes the whole class.
  stops.sort((x, y) => x[0] - y[0]);
  const css = stops.map(([p, c]) => `${c} ${p.toFixed(2)}%`).join(', ');
  wrap.style.setProperty('--day-ramp', `linear-gradient(90deg, ${css})`);
}
