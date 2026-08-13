import { spawn } from 'node:child_process';

const commands = [
  ['npm', ['run', 'dev', '--workspace=@wardform/backend']],
  ['npm', ['run', 'dev', '--workspace=web']],
];

const children = commands.map(([command, args]) =>
  spawn(command, args, { stdio: 'inherit', shell: false }),
);

function stop() {
  for (const child of children) child.kill('SIGTERM');
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

for (const child of children) {
  child.on('exit', (code) => {
    if (code && code !== 0) {
      stop();
      process.exitCode = code;
    }
  });
}
