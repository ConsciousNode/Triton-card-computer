// lp-check.js: apply the load path (loadpath.js) to each card and report what it adds (Kehai Interim). MIT.
const { cards } = require('./table-inventory.js'); const { addLoadPath } = require('./loadpath.js');
const which = process.argv.slice(2);
for (const [name, mk] of Object.entries(cards)) { if (which.length && !which.some(w => name.startsWith(w))) continue;
  const t0 = Date.now(); const card = mk(); const before = card.chips.length;
  try { addLoadPath(card, { worldLoad: { RESET: 1 } }); card.check(); const L = card.loadPath;
    console.log(`${name}: ${before} chips; adds ${JSON.stringify(L.added)}; ${L.pulls.length} nets pulled up in LOAD; ${L.swaps.length} swapped to 3-state; ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } catch (e) { console.log(name, 'ERROR', e.message.slice(0, 300)); } }
