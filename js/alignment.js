// Find next date when sunrise (or sunset) azimuth aligns with a target bearing.
// Brute-force one day at a time. Sub-millisecond per call so 365 days is fine.

import { getDayBoundaries, getPosition, getMoonPos } from './solar.js';
import { bearing as compassBearing } from './util.js';

const ONE_DAY = 86400000;

/**
 * @param {{lat:number, lon:number}} observer
 * @param {number} targetAzDeg compass bearing 0..360
 * @param {number} toleranceDeg
 * @param {Date} fromDate
 * @param {'sunrise'|'sunset'|'either'} kind
 * @returns {{date: Date, eventTime: Date, kind: string, azimuth: number, deltaDays: number} | null}
 */
export function findNextAlignment(observer, targetAzDeg, toleranceDeg, fromDate, kind = 'either') {
  const { lat, lon } = observer;
  const start = new Date(fromDate); start.setHours(12, 0, 0, 0);
  let bestSunrise = null, bestSunset = null;

  for (let d = 0; d < 366; d++) {
    const day = new Date(start.getTime() + d * ONE_DAY);
    const t = getDayBoundaries(day, lat, lon);

    if ((kind === 'sunrise' || kind === 'either') && t.sunrise && !bestSunrise) {
      const az = getPosition(t.sunrise, lat, lon).azimuthDeg;
      if (Math.abs(angDelta(targetAzDeg, az)) <= toleranceDeg) {
        bestSunrise = { date: day, eventTime: t.sunrise, kind: 'sunrise', azimuth: az, deltaDays: d };
      }
    }
    if ((kind === 'sunset' || kind === 'either') && t.sunset && !bestSunset) {
      const az = getPosition(t.sunset, lat, lon).azimuthDeg;
      if (Math.abs(angDelta(targetAzDeg, az)) <= toleranceDeg) {
        bestSunset = { date: day, eventTime: t.sunset, kind: 'sunset', azimuth: az, deltaDays: d };
      }
    }
    if (bestSunrise && bestSunset) break;
    if (kind === 'sunrise' && bestSunrise) break;
    if (kind === 'sunset' && bestSunset) break;
  }

  // Pick the soonest if both
  const candidates = [bestSunrise, bestSunset].filter(Boolean);
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.deltaDays - b.deltaDays);
  return candidates[0];
}

function angDelta(a, b) {
  return ((b - a + 540) % 360) - 180;
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
  const dphi = (lat2 - lat1) * Math.PI / 180;
  const dlam = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Find next datetime when the sun/moon aligns between two geographic points.
 * "Aligned" means the body is at the azimuth of A→B and the altitude that
 * matches the slope from A (at heightA metres) to B (at heightB metres).
 *
 * Two-pass strategy:
 *   Coarse pass  — 15-min steps, loose azimuth check (±6°).
 *   Fine pass    — 1-min steps ±15 min around each coarse hit.
 * This reliably catches the narrow window where both az and alt match even
 * when requiredAlt ≈ 0° (both points at the same height).
 *
 * @param {{lat:number, lon:number, height:number}} pointA  observer
 * @param {{lat:number, lon:number, height:number}} pointB  target
 * @param {Date} fromDate
 * @param {boolean} moonMode
 * @param {number} toleranceDeg  ±degrees for both azimuth and altitude match
 * @returns {{datetime:Date, azimuth:number, altitude:number} | null}
 */
export function findAlignmentBetweenPoints(pointA, pointB, fromDate, moonMode = false, toleranceDeg = 1.5) {
  const dist = haversineM(pointA.lat, pointA.lon, pointB.lat, pointB.lon);
  if (dist < 1) return null;
  const requiredAz  = compassBearing(pointA.lat, pointA.lon, pointB.lat, pointB.lon);
  const hDiff = (pointB.height || 0) - (pointA.height || 0);
  const requiredAlt = Math.atan2(hDiff, dist) * 180 / Math.PI;

  // When A is higher than B, requiredAlt < 0 (looking down). The sun can't be
  // below the horizon, so flip: search for the sun coming from the opposite
  // direction (B→A bearing) at the equivalent positive altitude.
  const searchAlt = Math.abs(requiredAlt);
  const searchAz  = requiredAlt < 0 ? (requiredAz + 180) % 360 : requiredAz;

  const COARSE  = 15 * 60 * 1000;
  const FINE    =  1 * 60 * 1000;
  const WINDOW  = 15 * 60 * 1000;  // fine scan ±15 min around coarse hit
  const MAX_MS  = 366 * 86400000;
  const getPos  = moonMode ? getMoonPos : getPosition;
  const start   = fromDate.getTime();
  // Skip positions clearly below where the sun needs to be — avoids most of the night.
  const skipBelow = searchAlt - toleranceDeg - 2;

  for (let tc = start; tc < start + MAX_MS; tc += COARSE) {
    const pc = getPos(new Date(tc), pointA.lat, pointA.lon);
    if (pc.altitudeDeg < skipBelow) continue;
    // Loose azimuth gate — coarse tolerance is 4.5° wider than the final check.
    if (Math.abs(angDelta(searchAz, pc.azimuthDeg)) > toleranceDeg + 4.5) continue;

    // Fine scan: 1-min steps in [tc-WINDOW, tc+WINDOW], clamped to search start.
    const fineStart = Math.max(start, tc - WINDOW);
    const fineEnd   = tc + WINDOW;
    for (let tf = fineStart; tf <= fineEnd; tf += FINE) {
      const pf = getPos(new Date(tf), pointA.lat, pointA.lon);
      if (pf.altitudeDeg < Math.max(0, skipBelow)) continue;  // sun must be above horizon
      if (Math.abs(angDelta(searchAz, pf.azimuthDeg)) > toleranceDeg) continue;
      if (Math.abs(pf.altitudeDeg - searchAlt) <= toleranceDeg) {
        // Refine to ~5 s so the alignment is tight: a 1.5° tolerance at a low sun
        // angle puts the shadow tip tens of metres off, so minimise the combined
        // az+alt error in a ±60 s window around the 1-min hit.
        let bestT = tf, bestErr = Infinity;
        for (let tr = tf - 60000; tr <= tf + 60000; tr += 5000) {
          if (tr < start) continue;
          const pr = getPos(new Date(tr), pointA.lat, pointA.lon);
          if (pr.altitudeDeg < 0) continue;
          const err = Math.abs(angDelta(searchAz, pr.azimuthDeg)) + Math.abs(pr.altitudeDeg - searchAlt);
          if (err < bestErr) { bestErr = err; bestT = tr; }
        }
        const pb = getPos(new Date(bestT), pointA.lat, pointA.lon);
        return { datetime: new Date(bestT), azimuth: pb.azimuthDeg, altitude: pb.altitudeDeg };
      }
    }
  }
  return null;
}
