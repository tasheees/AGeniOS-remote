#!/usr/bin/env node
/**
 * AGeniOS Remote — Asset export pipeline
 *
 * Outputs:
 *   lockup-transparent.png   — horizontal lockup, real alpha (no grey halo)
 *   lockup-dark.png          — same on dark bg
 *   og-1200x630.png          — OG banner
 *   icon-transparent.png     — AGeniOS⚡ / remote stacked icon, real alpha
 *   icon-dark.png            — same on dark bg
 *   icon-512.png             — 512×512 square
 */

const puppeteer        = require('puppeteer-core');
const { execSync }     = require('child_process');
const fs               = require('fs');
const path             = require('path');

// ── Paths ─────────────────────────────────────────────────────────────────────
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FONT_SRC    = '/Users/marwantzenios/projects/contact-verification/src/app/fonts/GeistVF.woff';
const LOCKUP_HTML = path.resolve(__dirname, 'lockup-render.html');
const ICON_HTML   = path.resolve(__dirname, 'icon-render.html');
const OUT         = path.join(__dirname, 'png');
const TMP         = path.join(__dirname, '.tmp');

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

// ── ImageMagick ───────────────────────────────────────────────────────────────
let IM;
try { execSync('which magick', { stdio: 'pipe' }); IM = 'magick'; }
catch { IM = 'convert'; }

function trim(i, o) {
  execSync(`${IM} "${i}" -trim +repage "${o}"`, { stdio: 'pipe' });
}
function onDark(i, o) {
  execSync(`${IM} "${i}" -background "#0a0a0c" -alpha remove -alpha off "${o}"`, { stdio: 'pipe' });
}
function done(f) {
  const kb = (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(1);
  console.log(`  ✅  ${f}  (${kb} KB)`);
}

// ── Font injection CSS ────────────────────────────────────────────────────────
const GEIST_B64 = fs.readFileSync(FONT_SRC).toString('base64');
const FONT_CSS  = `
  @font-face {
    font-family: 'Geist';
    src: url('data:font/woff;base64,${GEIST_B64}') format('woff');
    font-weight: 100 900;
  }
  * { font-family: 'Geist', sans-serif !important; }
`;

// ── Core screenshot helper ────────────────────────────────────────────────────
async function shoot(htmlFile, selectorFn, outPng) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlFile}`, { waitUntil: 'domcontentloaded' });

  // Inject Geist + wait for it to apply
  await page.addStyleTag({ content: FONT_CSS });
  await page.evaluateHandle('document.fonts.ready');
  await new Promise(r => setTimeout(r, 500));

  // Switch to 4× DPR for crisp output
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 4 });

  // Measure the clip area inside the page
  const clip = await page.evaluate(selectorFn);

  // omitBackground:true → native alpha channel — zero grey halo on text edges
  await page.screenshot({ path: outPng, clip, omitBackground: true });
  await browser.close();
}

// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  // ── 1. Lockup ───────────────────────────────────────────────────────────────
  console.log('\n── Lockup ──────────────────────────────────────────');
  const lockupRaw = path.join(TMP, 'lockup.png');

  await shoot(LOCKUP_HTML, () => {
    const c   = document.querySelector('#logo-container').getBoundingClientRect();
    const sub = document.querySelector('.brand-lockup-sub').getBoundingClientRect();
    return {
      x:      Math.floor(c.x),
      y:      Math.floor(c.y),
      width:  Math.ceil(c.width),
      height: Math.ceil(sub.bottom - c.y + 5), // include "remote" + underline
    };
  }, lockupRaw);

  fs.copyFileSync(lockupRaw, path.join(OUT, 'lockup-transparent.png'));
  done('lockup-transparent.png');

  // Dark bg at exact lockup size
  execSync(`${IM} "${lockupRaw}" -background "#0a0a0c" -alpha remove -alpha off "${path.join(OUT,'lockup-dark.png')}"`, { stdio: 'pipe' });
  done('lockup-dark.png');

  // OG Banner
  const lockupTrim = path.join(TMP, 'lockup-trim.png');
  trim(lockupRaw, lockupTrim);
  const ogLockup = path.join(TMP, 'og-lockup.png');
  execSync(`${IM} "${lockupTrim}" -resize 960x "${ogLockup}"`, { stdio: 'pipe' });
  execSync(`${IM} -size 1200x630 gradient:"#0a0a0c-#12082a" "${path.join(TMP,'og-bg.png')}"`, { stdio: 'pipe' });
  execSync(`${IM} "${path.join(TMP,'og-bg.png')}" "${ogLockup}" -gravity center -composite "${path.join(OUT,'og-1200x630.png')}"`, { stdio: 'pipe' });
  done('og-1200x630.png');

  // ── 2. Icon (AGeniOS⚡ / remote stacked) ────────────────────────────────────
  console.log('\n── Icon ────────────────────────────────────────────');
  const iconRaw = path.join(TMP, 'icon.png');

  await shoot(ICON_HTML, () => {
    const c = document.getElementById('icon-container').getBoundingClientRect();
    return {
      x:      Math.floor(c.x),
      y:      Math.floor(c.y),
      width:  Math.ceil(c.width),
      height: Math.ceil(c.height),
    };
  }, iconRaw);

  fs.copyFileSync(iconRaw, path.join(OUT, 'icon-transparent.png'));
  done('icon-transparent.png');

  execSync(`${IM} "${iconRaw}" -background "#0a0a0c" -alpha remove -alpha off "${path.join(OUT,'icon-dark.png')}"`, { stdio: 'pipe' });
  done('icon-dark.png');

  // 512×512 square
  const iconTrim = path.join(TMP, 'icon-trim.png');
  trim(iconRaw, iconTrim);
  execSync(`${IM} "${iconTrim}" -resize 400x "${path.join(TMP,'icon-resized.png')}"`, { stdio: 'pipe' });
  execSync(`${IM} -size 512x512 xc:"#0a0a0c" "${path.join(TMP,'sq.png')}"`, { stdio: 'pipe' });
  execSync(`${IM} "${path.join(TMP,'sq.png')}" "${path.join(TMP,'icon-resized.png')}" -gravity center -composite "${path.join(OUT,'icon-512.png')}"`, { stdio: 'pipe' });
  done('icon-512.png');

  // ── Done ─────────────────────────────────────────────────────────────────────
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\nAll assets → ${OUT}/`);
})();
