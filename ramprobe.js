const path=require('path'); process.chdir(__dirname);
const { loadHtmlModule, makeMouseTracker } = require(path.resolve(require(__dirname+'/triton-dir.js')+'/desktop/tests/t3-common.js'));
const { T } = loadHtmlModule('tritos-desktop.html');
const vm = T.TritonWASM.createSync({ archMode: 'T3' });
T.bootTritOSDesktop(vm, false);
vm.run(600000);
const mouse = makeMouseTracker(vm);
const t0 = vm.steps;
for (let x = 20; x <= 720; x += 34) { mouse.click(x, 472, 250000); }
vm.run(3000000);
const mem = vm.mem; const N = vm.ramSize;
let max = -1, nz = 0;
for (let i = 0; i < N; i++) if (mem[i] !== 0) { nz++; max = i; }
// tasks running
let tasks = 0; for (let t = 0; t < 8; t++) if (mem[6000 + t*64 + 42] === 1) tasks++;
console.log(JSON.stringify({ramSize:N, highestNonzeroTryte:max, nonzeroTrytes:nz, runningTasks:tasks, stepsSimulated:vm.steps}));
