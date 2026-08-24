// Renders the SVG app icon into the PNG sizes the manifest references.
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';

const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const svg = await readFile(new URL('../public/icons/icon.svg', import.meta.url), 'utf8');

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage();

const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['apple-touch-icon.png', 180, false],
  ['maskable-512.png', 512, true],
];

for (const [name, size, maskable] of targets) {
  // Maskable icons need their art inside the 80% safe zone.
  const inner = maskable
    ? `<div style="width:100%;height:100%;background:#111417;display:flex;align-items:center;justify-content:center">
         <div style="width:72%;height:72%">${svg}</div>
       </div>`
    : svg;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0;width:${size}px;height:${size}px">${inner}</body>`,
  );
  await page.locator('body').first().waitFor();
  const png = await page.screenshot({ omitBackground: !maskable });
  await writeFile(new URL(`../public/icons/${name}`, import.meta.url), png);
  console.log(`  ${name} (${size}px)`);
}

await browser.close();
