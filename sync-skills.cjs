const fs = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

function entries(directory) {
  try {
    return fs.readdirSync(directory).sort();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    warn(error);
    return [];
  }
}

function warn(error) {
  process.stderr.write(`offload-worker skill sync: ${error.message}\n`);
}

function syncSkills() {
  const home = homedir();
  const config = join(home, '.gemini', 'config');
  const plugins = join(config, 'plugins');
  const destination = join(process.env.CODEX_HOME || join(home, '.codex'), 'skills');
  const sources = [
    join(config, 'skills'),
    ...entries(plugins).map(name => join(plugins, name, 'skills')),
  ];

  for (const source of sources) {
    for (const name of entries(source)) {
      if (name.toLowerCase() === '.system') continue;

      const skill = join(source, name);
      const link = join(destination, name);
      try {
        if (!fs.statSync(join(skill, 'SKILL.md'), { throwIfNoEntry: false })?.isFile()) continue;
        if (fs.lstatSync(link, { throwIfNoEntry: false })) continue;

        fs.mkdirSync(destination, { recursive: true });
        // Link creation is exclusive, including when an existing link is dangling.
        fs.symlinkSync(fs.realpathSync(skill), link, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if (error.code === 'EEXIST' && error.syscall === 'symlink') continue;
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
        warn(error);
      }
    }
  }
}

syncSkills();
