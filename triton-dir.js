// Where the ConsciousNode/Triton checkout lives (the card tests compare against its reference emulator).
// Set TRITON_DIR, or clone Triton next to this repo (../Triton or ../triton).
const path = require('path'), fs = require('fs');
const cands = [process.env.TRITON_DIR, path.resolve(__dirname, '..', 'Triton'), path.resolve(__dirname, '..', 'triton')].filter(Boolean);
const dir = cands.find(d => fs.existsSync(path.join(d, 'triton3.html')));
if (!dir) throw new Error('Triton checkout not found: set TRITON_DIR or clone ConsciousNode/Triton next to this repo');
module.exports = dir;
