#!/usr/bin/env node
/**
 * AGeniOS Remote — S→Bolt substitution test
 * Renders "AGeniO" text, measures its exact pixel width,
 * then places the bolt precisely where S would be.
 * Outputs side-by-side comparison: original vs bolt-S version.
 */

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'png');
const TMP = path.join(__dirname, '.tmp-bolts');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const BOLT   = `M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z`;
const FONT   = `Geist, Helvetica Neue, Arial, sans-serif`;
const DARK   = `#0a0a0c`;
const VIOLET = `#7c3aed`;
const IM     = 'magick';

const FONT_SIZE  = 90;   // "AGeniOS" font size (large for quality)
const ZOOM       = 2;    // rsvg zoom for sharpness

// ── Step 1: Measure exact width of "AGeniO" by rendering + trimming ───────────
const svgMeasure = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3000 140">
  <text x="0" y="${FONT_SIZE}" font-family="${FONT}" font-weight="800"
        font-size="${FONT_SIZE}" fill="#ffffff" letter-spacing="-1">AGeniO</text>
</svg>`;
fs.writeFileSync(`${TMP}/measure.svg`, svgMeasure);
execSync(`rsvg-convert "${TMP}/measure.svg" --zoom=${ZOOM} -o "${TMP}/measure.png"`, { stdio: 'pipe' });
execSync(`${IM} "${TMP}/measure.png" -trim +repage "${TMP}/measure-trim.png"`, { stdio: 'pipe' });
const textW = parseInt(execSync(`${IM} identify -format "%w" "${TMP}/measure-trim.png"`).toString().trim());
const textH = parseInt(execSync(`${IM} identify -format "%h" "${TMP}/measure-trim.png"`).toString().trim());
console.log(`"AGeniO" rendered: ${textW}×${textH}px  (zoom ${ZOOM}×)`);

// Cap height ≈ 72% of font-size at zoom
const capH   = Math.round(FONT_SIZE * ZOOM * 0.72);
// Bolt fills viewBox 0 0 24 24 — scale to match cap height
const bScale = capH / 24;
// Y offset: baseline is at FONT_SIZE*ZOOM, cap top at (FONT_SIZE*ZOOM - capH)
const boltY  = Math.round(FONT_SIZE * ZOOM - capH);
// X: right after "AGeniO" with a 2px nudge
const boltX  = textW + Math.round(2 * ZOOM);

console.log(`Cap height: ${capH}px | Bolt scale: ${bScale.toFixed(2)} | Position: (${boltX}, ${boltY})`);

// ── Step 2: Measure "S" width (for spacing reference) ────────────────────────
const svgS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 140">
  <text x="0" y="${FONT_SIZE}" font-family="${FONT}" font-weight="800"
        font-size="${FONT_SIZE}" fill="#ffffff" letter-spacing="-1">S</text>
</svg>`;
fs.writeFileSync(`${TMP}/s.svg`, svgS);
execSync(`rsvg-convert "${TMP}/s.svg" --zoom=${ZOOM} -o "${TMP}/s.png"`, { stdio: 'pipe' });
execSync(`${IM} "${TMP}/s.png" -trim +repage "${TMP}/s-trim.png"`, { stdio: 'pipe' });
const sW = parseInt(execSync(`${IM} identify -format "%w" "${TMP}/s-trim.png"`).toString().trim());
console.log(`"S" width: ${sW}px`);

// ── Step 3: Build original reference PNG ─────────────────────────────────────
const canvasW = (textW + sW + 200) + 80;  // generous canvas
const canvasH = FONT_SIZE * ZOOM * 2;

const svgOriginal = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">
  <text x="0" y="${FONT_SIZE * ZOOM}" font-family="${FONT}" font-weight="800"
        font-size="${FONT_SIZE * ZOOM}" fill="#ffffff" letter-spacing="${-2 * ZOOM}">AGeniOS</text>
  <text x="0" y="${FONT_SIZE * ZOOM + 52 * ZOOM * 0.5}" font-family="${FONT}" font-weight="400"
        font-size="${32 * ZOOM}" fill="#6b7280">remote</text>
  <line x1="0" y1="${FONT_SIZE * ZOOM + 70 * ZOOM * 0.5}"
        x2="${88 * ZOOM * 0.5}" y2="${FONT_SIZE * ZOOM + 70 * ZOOM * 0.5}"
        stroke="${VIOLET}" stroke-width="${2.5 * ZOOM * 0.5}" stroke-opacity="0.55"/>
</svg>`;
fs.writeFileSync(`${TMP}/original.svg`, svgOriginal);
execSync(`rsvg-convert "${TMP}/original.svg" -o "${TMP}/original.png"`, { stdio: 'pipe' });
execSync(`${IM} "${TMP}/original.png" -trim +repage "${TMP}/original-trim.png"`, { stdio: 'pipe' });
execSync(`${IM} "${TMP}/original-trim.png" -background "${DARK}" -flatten -bordercolor "${DARK}" -border 40 "${OUT}/logo-original.png"`, { stdio: 'pipe' });
console.log('✅  logo-original.png  (reference)');

// ── Step 4: Build bolt-as-S version ──────────────────────────────────────────
// Render "AGeniO" at exact zoom, then composite bolt at measured position
const svgBoltS = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">
  <!-- AGeniO text -->
  <text x="0" y="${FONT_SIZE * ZOOM}" font-family="${FONT}" font-weight="800"
        font-size="${FONT_SIZE * ZOOM}" fill="#ffffff" letter-spacing="${-2 * ZOOM}">AGeniO</text>
  <!-- Bolt replacing S — measured position -->
  <g transform="translate(${boltX}, ${boltY}) scale(${bScale})">
    <path d="${BOLT}" fill="none" stroke="${VIOLET}"
          stroke-width="${1.4 / bScale * (ZOOM)}"
          stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <!-- remote -->
  <text x="0" y="${FONT_SIZE * ZOOM + 52 * ZOOM * 0.5}" font-family="${FONT}" font-weight="400"
        font-size="${32 * ZOOM}" fill="#6b7280">remote</text>
  <line x1="0" y1="${FONT_SIZE * ZOOM + 70 * ZOOM * 0.5}"
        x2="${88 * ZOOM * 0.5}" y2="${FONT_SIZE * ZOOM + 70 * ZOOM * 0.5}"
        stroke="${VIOLET}" stroke-width="${2.5 * ZOOM * 0.5}" stroke-opacity="0.55"/>
</svg>`;
fs.writeFileSync(`${TMP}/bolt-s.svg`, svgBoltS);
execSync(`rsvg-convert "${TMP}/bolt-s.svg" -o "${TMP}/bolt-s.png"`, { stdio: 'pipe' });
execSync(`${IM} "${TMP}/bolt-s.png" -trim +repage "${TMP}/bolt-s-trim.png"`, { stdio: 'pipe' });
execSync(`${IM} "${TMP}/bolt-s-trim.png" -background "${DARK}" -flatten -bordercolor "${DARK}" -border 40 "${OUT}/logo-bolt-as-s.png"`, { stdio: 'pipe' });
console.log('✅  logo-bolt-as-s.png  (S replaced by bolt)');

// ── Step 5: Side-by-side comparison ──────────────────────────────────────────
execSync(
  `${IM} "${OUT}/logo-original.png" "${OUT}/logo-bolt-as-s.png" -append "${OUT}/logo-comparison.png"`,
  { stdio: 'pipe' }
);
console.log('✅  logo-comparison.png  (stacked: original / bolt-S)');

// Cleanup
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nAll → ${OUT}/`);
