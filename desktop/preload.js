const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petsBridge', {
  /*
   * The renderer cannot read the environment, and console messages from it are
   * forwarded to the terminal under STRAYS_DEBUG anyway — so this is the whole
   * of what the lane needs to know to explain a throw it got wrong. Release
   * latency is a property of the pointing device (a trackpad suppresses the end
   * of a flick as the finger lifts, by an amount nothing here can derive), so
   * the numbers have to come off the machine that felt it.
   */
  debug: !!process.env.STRAYS_DEBUG,
  onClaudeStatus: (cb) => ipcRenderer.on('claude-status', (_e, s) => cb(s)),
  onParty: (cb) => ipcRenderer.on('party', (_e, on) => cb(on)),
  onCelebrate: (cb) => ipcRenderer.on('celebrate', () => cb()),
  onCustomPets: (cb) => ipcRenderer.on('custom-pets', (_e, defs) => cb(defs)),
  onRoster: (cb) => ipcRenderer.on('roster', (_e, ids) => cb(ids)),
  onUsage: (cb) => ipcRenderer.on('usage', (_e, stats) => cb(stats)),
  onShowTitles: (cb) => ipcRenderer.on('show-titles', (_e, on) => cb(on)),
  onObserved: (cb) => ipcRenderer.on('observed', (_e, on) => cb(on)),
  onMischief: (cb) => ipcRenderer.on('show-mischief', (_e, on) => cb(on)),
  onApprovalRequest: (cb) => ipcRenderer.on('approval-request', (_e, req) => cb(req)),
  onApprovalRemove: (cb) => ipcRenderer.on('approval-remove', (_e, id) => cb(id)),
  approvalReply: (id, decision) => ipcRenderer.send('approval-reply', { id, decision }),
  jumpToSession: (session) => ipcRenderer.send('jump-to-session', session),
  setInteractive: (on) => ipcRenderer.send('set-interactive', on),
});
