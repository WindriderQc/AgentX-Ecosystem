// gauge-ring.js — SVG circular gauge ring for performance board
export function gaugeRing(value, max, { label, unit, size = 70, color = '#4fc3f7' } = {}) {
  const r = (size - 10) / 2;
  const circumference = 2 * Math.PI * r;
  const pct = Math.min(1, value / max);
  const offset = circumference * (1 - pct);
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="r-gauge">
    <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="var(--r-border)" stroke-width="5"/>
    <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${color}" stroke-width="5"
      stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"
      stroke-linecap="round" transform="rotate(-90 ${size/2} ${size/2})"/>
    <text x="${size/2}" y="${size/2 - 4}" text-anchor="middle" fill="${color}" font-size="0.85rem" font-weight="800">${Math.round(value)}</text>
    <text x="${size/2}" y="${size/2 + 10}" text-anchor="middle" fill="var(--r-text-dim)" font-size="0.45rem">${unit || ''}</text>
  </svg>`;
}
