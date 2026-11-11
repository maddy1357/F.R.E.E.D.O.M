// Launch Electron with a clean environment.
// VS Code's terminal sets ELECTRON_RUN_AS_NODE=1, which makes Electron behave like plain Node
// and the app crashes on start. Removing it here makes `npm start` work from any terminal.
const { spawn } = require('child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env, cwd: __dirname + '/..' });
child.on('close', (code) => process.exit(code ?? 0));
