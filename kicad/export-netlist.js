// export-netlist.js: one card of the integrated machine as JSON for the KiCad builder (Kehai Interim, 2026-11-22). MIT.
// usage: node kicad/export-netlist.js <Card> > out.json   (chips: ref, part, pins {name: net}; card-local nets keep
// their "Card:" prefix stripped; backplane nets keep their own names, so the DIN 41612 pins can be matched by name)
'use strict';
const { compose } = require('../integration/integrate.js');
const card = process.argv[2]; const m = compose();
const chips = m.chips.filter(c => c.ref.startsWith(card + '.')).map(c => ({ ref: c.ref.slice(card.length + 1), part: c.part,
  pins: Object.fromEntries(Object.entries(c.pins).map(([p, n]) => [p, String(n).startsWith(card + ':') ? String(n).slice(card.length + 1) : String(n)])) }));
process.stdout.write(JSON.stringify({ card, chips }, null, 0));
