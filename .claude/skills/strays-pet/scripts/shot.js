/*
 * Render a pet through the engine's own draw path and write a PNG.
 *
 * capturePage rather than screencapture(1): it needs no Screen Recording
 * permission, needs no visible window, and is the only way to prove the sprite is
 * actually on screen. A headless harness can only prove fillText was called.
 *
 *   CUSTOM_PETS=~/.strays/custom-pets.json \
 *     ./node_modules/.bin/electron .claude/skills/strays-pet/scripts/shot.js
 *
 *   CUSTOM_PETS  path to a pet def (an array, or a single object)
 *   PET          index into that array (default 0)
 *   SCALE        pixels per cell (default 6; the overlay ships 4)
 *   BUILTINS=1   put the built-in pets in the same shot, for size comparison
 *   STATES       comma-separated (default walk,walk,sit,sleep)
 *   OUT          output path (default ./pet.png)
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const petsFile = (process.env.CUSTOM_PETS || '').replace(/^~/, require('os').homedir());
const parsed = JSON.parse(fs.readFileSync(petsFile, 'utf8'));
const def = Array.isArray(parsed) ? parsed[Number(process.env.PET || 0)] : parsed;

const opts = {
  scale: Number(process.env.SCALE || 6),
  builtins: process.env.BUILTINS === '1',
  gap: Number(process.env.GAP || (process.env.BUILTINS === '1' ? 110 : 200)),
  states: (process.env.STATES || 'walk,walk,sit,sleep').split(','),
};
const OUT = path.resolve(process.env.OUT || 'pet.png');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900, height: 300, show: false,
    webPreferences: { offscreen: true },
  });
  win.webContents.on('console-message', (_e, _l, m) => console.log('[lane]', m));
  await win.loadFile(path.join(__dirname, 'shot.html'));
  const listed = await win.webContents.executeJavaScript(
    `window.__setup(${JSON.stringify(def)}, ${JSON.stringify(opts)})`,
  );
  console.log('drew:', listed.join(' | '));
  // let the loop settle so the sprite cache is warm and the first frame is past
  await new Promise((r) => setTimeout(r, 1200));
  fs.writeFileSync(OUT, (await win.webContents.capturePage()).toPNG());
  console.log('wrote', OUT);
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
