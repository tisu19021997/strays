/*
 * The Pets window's only bridge to the main process.
 *
 * Separate from preload.js on purpose: that one hands the overlay the pointer
 * lease, approval replies and session jumps, none of which a settings window has
 * any business being able to call. Two small surfaces beat one that is the union
 * of both.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('straysPets', {
  // { pets: [{ id, name, custom, grids, palette }], enabled: string[], toggles: {} }
  load: () => ipcRenderer.invoke('pets:load'),
  // the whole list, every time: the window is the only thing that knows the order
  save: (roster) => ipcRenderer.send('pets:save', roster),
  setToggle: (key, value) => ipcRenderer.send('pets:toggle', { key, value }),
  celebrate: () => ipcRenderer.send('pets:celebrate'),
  // a pet adopted or deleted while the window is open
  onPetsChanged: (cb) => ipcRenderer.on('pets:changed', () => cb()),
});
