#!/usr/bin/env node
/**
 * AGeniOS Remote — Browser-accurate PNG export
 * Screenshots the EXACT HTML lockup (same CSS as PWA) using headless Chrome.
 * This guarantees pixel-perfect output matching the PWA header.
 */

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const OUT    = path.join(__dirname, 'png');
const TMP    = path.join(__dirname, '.tmp');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HTML   = path.join(__dirname, 'lockup-render.html');

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

let IM;
try { execSync('which magick', { stdio: 'pipe' }); IM = 'magick'; }
catch { IM = 'convert'; }

function trim(i, o)            { execSync(`${IM} "${i}" -trim +repage "${o}"`, { stdio: 'pipe' }); }
function padSolid(i, o, px, bg){ execSync(`${IM} "${i}" -background "${bg}" -flatten -bordercolor "${bg}" -border ${px} "${o}"`, { stdio: 'pipe' }); }
function done(f) {
  const p = path.join(OUT, f);
  const kb = (fs.statSync(p).size / 1024).toFixed(1);
  console.log(`  ✅  ${f}  (${kb}KB)`);
}

// ── Screenshot scales ─────────────────────────────────────────────────────────
// device-scale-factor controls how many screen pixels per CSS pixel.
// 4× gives crisp text at very high resolution matching the mock zoom feel.
const scales = [
  { name: 'lockup-1x',  dpr: 1,  note: 'exact PWA size' },
  { name: 'lockup-2x',  dpr: 2,  note: 'retina / 2× zoom' },
  { name: 'lockup-4x',  dpr: 4,  note: '4× zoom — large preview' },
];

for (const { name, dpr, note } of scales) {
  console.log(`\n── ${name}  (${note}) ─────────────────────────────────`);
  const rawPng = path.join(TMP, `${name}-raw.png`);
  const trimPng = path.join(TMP, `${name}-trim.png`);
  const outPng  = path.join(OUT, `${name}-transparent.png`);
  const darkPng = path.join(OUT, `${name}-dark.png`);

  // Headless Chrome screenshot — large window, content clips to body width
  execSync(
    `"${CHROME}" \
      --headless=new \
      --disable-gpu \
      --no-sandbox \
      --hide-scrollbars \
      --disable-extensions \
      --force-device-scale-factor=${dpr} \
      --window-size=800,300 \
      --screenshot="${rawPng}" \
      "file://${HTML}"`,
    { stdio: 'pipe' }
  );

  // Trim the screenshot to tight content bounds, then strip dark bg for transparent
  execSync(`${IM} "${rawPng}" -trim +repage "${trimPng}"`, { stdio: 'pipe' });

  // Remove the dark background → transparent version
  execSync(
    `${IM} "${trimPng}" -fuzz 5% -transparent "#0a0a0c" "${outPng}"`,
    { stdio: 'pipe' }
  );
  done(`${name}-transparent.png`);

  // Dark bg version (original trim, no transparency)
  padSolid(trimPng, darkPng, Math.round(24 * dpr), '#0a0a0c');
  done(`${name}-dark.png`);
}

// ── OG Banner from 4× lockup ──────────────────────────────────────────────────
console.log('\n── OG Banner 1200×630 ──────────────────────────────');
const lockup4x  = path.join(TMP, 'lockup-4x-trim.png');
const ogLockup  = path.join(TMP, 'lockup-og-scaled.png');
const gradBg    = path.join(TMP, 'og-bg.png');
const ogOut     = path.join(OUT, 'og-1200x630.png');

execSync(`${IM} "${lockup4x}" -resize 960x "${ogLockup}"`, { stdio: 'pipe' });
execSync(`${IM} -size 1200x630 gradient:"#0a0a0c-#12082a" "${gradBg}"`, { stdio: 'pipe' });
execSync(`${IM} "${gradBg}" "${ogLockup}" -gravity center -composite "${ogOut}"`, { stdio: 'pipe' });
done('og-1200x630.png');

// ── Cleanup ───────────────────────────────────────────────────────────────────
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nAll → ${OUT}/`);
