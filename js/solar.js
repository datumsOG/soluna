// Solar calculations wrapper around SunCalc.
// SunCalc returns azimuth in radians measured from south, going west (positive).
// We convert to compass bearing: degrees from north, clockwise (0=N, 90=E, 180=S, 270=W).

import * as SunCalc from '../vendor/suncalc.js';

export const RAD2DEG = 180 / Math.PI;
const SUN_DISC_REFRACTION_DEG = 0.833; // SunCalc's default for sunrise/sunset

/** Instantaneous sun altitude/azimuth in degrees (compass bearing). */
export function getPosition(date, lat, lon) {
  const p = SunCalc.getPosition(date, lat, lon);
  return {
    altitudeDeg: p.altitude * RAD2DEG,
    azimuthDeg: azRadFromSouthToCompassDeg(p.azimuth),
  };
}

/** Full set of day boundary events including twilight bands. */
export function getDayBoundaries(date, lat, lon) {
  const t = SunCalc.getTimes(date, lat, lon);
  return {
    sunrise: t.sunrise,
    sunset: t.sunset,
    solarNoon: t.solarNoon,
    goldenHourMorningEnd: t.goldenHourEnd,
    goldenHourEveningStart: t.goldenHour,
    civilDawn: t.dawn,
    civilDusk: t.dusk,
    nauticalDawn: t.nauticalDawn,
    nauticalDusk: t.nauticalDusk,
    astronomicalDawn: t.nightEnd,
    astronomicalDusk: t.night,
  };
}

function azRadFromSouthToCompassDeg(azRad) {
  // SunCalc: 0 = south, +pi/2 = west.  Compass: 0 = north, +90 = east.
  // Compass = 180 + (azRad * 180/pi), then mod 360.
  let deg = 180 + azRad * RAD2DEG;
  deg = ((deg % 360) + 360) % 360;
  return deg;
}

function startOfLocalDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Sun rise / set / golden-hour times for the given local date.
 * If horizonDipDeg is non-zero, scan the elevation curve to find the
 * times when the sun's altitude crosses (-SUN_DISC_REFRACTION_DEG - dip).
 */
export function getSunTimes(date, lat, lon, horizonDipDeg = 0) {
  const baseTimes = SunCalc.getTimes(date, lat, lon);
  const out = {
    sunrise: baseTimes.sunrise,
    sunset: baseTimes.sunset,
    solarNoon: baseTimes.solarNoon,
    goldenHourStart: baseTimes.goldenHour,     // evening start
    goldenHourEnd: baseTimes.goldenHourEnd,    // morning end
  };

  if (horizonDipDeg && Math.abs(horizonDipDeg) > 0.001) {
    const targetAltDeg = -SUN_DISC_REFRACTION_DEG - horizonDipDeg;
    const adjusted = findHorizonCrossings(date, lat, lon, targetAltDeg);
    if (adjusted.sunrise) out.sunrise = adjusted.sunrise;
    if (adjusted.sunset) out.sunset = adjusted.sunset;
  }

  return out;
}

function findHorizonCrossings(date, lat, lon, targetAltDeg) {
  // Scan the day in 30s steps, find first ascending crossing (sunrise)
  // and first descending crossing (sunset) of `targetAltDeg`.
  const start = startOfLocalDay(date).getTime();
  const stepMs = 30 * 1000;
  const steps = (24 * 3600 * 1000) / stepMs;
  let prevT = start;
  let prevAlt = SunCalc.getPosition(new Date(start), lat, lon).altitude * RAD2DEG;
  let sunrise = null, sunset = null;

  for (let i = 1; i <= steps; i++) {
    const t = start + i * stepMs;
    const alt = SunCalc.getPosition(new Date(t), lat, lon).altitude * RAD2DEG;
    if (!sunrise && prevAlt < targetAltDeg && alt >= targetAltDeg) {
      sunrise = new Date(linInterp(prevT, t, prevAlt, alt, targetAltDeg));
    }
    if (!sunset && prevAlt >= targetAltDeg && alt < targetAltDeg && sunrise) {
      sunset = new Date(linInterp(prevT, t, prevAlt, alt, targetAltDeg));
    }
    prevT = t; prevAlt = alt;
    if (sunrise && sunset) break;
  }
  return { sunrise, sunset };
}

function linInterp(t0, t1, v0, v1, target) {
  const f = (target - v0) / (v1 - v0);
  return t0 + f * (t1 - t0);
}

// ── Moon ──────────────────────────────────────────────────────────────────────

/** Moon altitude + azimuth in degrees (same convention as getPosition). */
export function getMoonPos(date, lat, lon) {
  const p = SunCalc.getMoonPosition(date, lat, lon);
  return {
    altitudeDeg: p.altitude * RAD2DEG,
    azimuthDeg: azRadFromSouthToCompassDeg(p.azimuth),
  };
}

/**
 * Moon illumination data.
 * phase: 0=new · 0.25=first quarter · 0.5=full · 0.75=last quarter
 * fraction: 0–1 lit fraction
 * waxing: true before full moon
 */
/** Moon rise/set on a local-day basis. Returns { rise, set } (either may be null). */
export function getMoonTimes(date, lat, lon) {
  const t = SunCalc.getMoonTimes(date, lat, lon, true);
  return { rise: t.rise || null, set: t.set || null };
}

export function getMoonIllumination(date) {
  const m = SunCalc.getMoonIllumination(date);
  return {
    phase: m.phase,
    fraction: m.fraction,
    waxing: m.angle < 0,
  };
}

/** Compass bearing of the sun at `date`, in degrees from north, clockwise. */
export function getAzimuth(date, lat, lon) {
  const p = SunCalc.getPosition(date, lat, lon);
  return azRadFromSouthToCompassDeg(p.azimuth);
}

/**
 * Elevation/azimuth curve from local midnight to next midnight.
 * Returns array of { t: Date, alt: deg, az: deg }.
 */
export function getElevationCurve(date, lat, lon, stepMin = 5) {
  const start = startOfLocalDay(date).getTime();
  const stepMs = stepMin * 60 * 1000;
  const n = (24 * 60) / stepMin + 1;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = new Date(start + i * stepMs);
    const p = SunCalc.getPosition(t, lat, lon);
    out[i] = {
      t,
      alt: p.altitude * RAD2DEG,
      az: azRadFromSouthToCompassDeg(p.azimuth),
    };
  }
  return out;
}
