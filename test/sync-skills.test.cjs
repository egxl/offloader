const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');

test('MCP startup links skills and preserves existing Codex entries', t => {
  const home = fs.mkdtempSync(join(tmpdir(), 'offload skills '));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const config = join(home, '.gemini', 'config');
  const plugins = join(config, 'plugins');
  const worker = join(plugins, 'offload-worker');
  const destination = join(home, '.codex', 'skills');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  function skill(root, name, content) {
    const directory = join(root, name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(join(directory, 'SKILL.md'), content);
    return directory;
  }
  function read(name) {
    return fs.readFileSync(join(destination, name, 'SKILL.md'), 'utf8');
  }

  const globalSkills = join(config, 'skills');
  const global = skill(globalSkills, 'shared', 'global');
  const pluginSkills = join(worker, 'skills');
  skill(pluginSkills, 'shared', 'plugin duplicate');
  const bundled = skill(pluginSkills, 'bundled', 'bundled');
  skill(join(plugins, 'zzz', 'skills'), 'bundled', 'later plugin');
  skill(globalSkills, '.system', 'reserved');
  skill(globalSkills, 'custom', 'source');
  skill(globalSkills, 'dangling', 'source');
  fs.mkdirSync(join(globalSkills, 'invalid'));
  fs.writeFileSync(join(globalSkills, 'file'), 'not a skill');
  skill(destination, 'custom', 'user');
  const removedTarget = join(home, 'removed target');
  fs.mkdirSync(removedTarget);
  try {
    fs.symlinkSync(removedTarget, join(destination, 'dangling'), linkType);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    t.skip(`Filesystem denied ${linkType} creation (${error.code})`);
    return;
  }
  fs.rmdirSync(removedTarget);
  fs.copyFileSync(join(__dirname, '..', 'sync-skills.cjs'), join(worker, 'sync-skills.cjs'));

  const { command, args } = require('../mcp_config.json').mcpServers['offload-worker'];
  const startupOptions = args.slice(0, -1);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CODEX_HOME;
  function start(extraEnv = {}) {
    const result = spawnSync(command, [...startupOptions, '-e', 'process.stdout.write("server")'], {
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'server');
    assert.equal(result.stderr, '');
  }

  start();
  start();
  assert.deepEqual(fs.readdirSync(destination).sort(), ['bundled', 'custom', 'dangling', 'shared']);
  assert.equal(fs.realpathSync(join(destination, 'shared')), fs.realpathSync(global));
  assert.equal(fs.realpathSync(join(destination, 'bundled')), fs.realpathSync(bundled));
  assert.equal(read('custom'), 'user');
  assert.throws(() => fs.statSync(join(destination, 'dangling')), { code: 'ENOENT' });
  fs.writeFileSync(join(bundled, 'SKILL.md'), 'updated');
  assert.equal(read('bundled'), 'updated');

  const codexHome = join(home, 'custom codex home');
  start({ CODEX_HOME: codexHome });
  assert.equal(fs.readFileSync(join(codexHome, 'skills', 'bundled', 'SKILL.md'), 'utf8'), 'updated');
});

test('MCP startup attempts each unique link and leaves existing entries alone', t => {
  const home = fs.mkdtempSync(join(tmpdir(), 'offload startup '));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = join(home, '.gemini', 'config');
  const worker = join(config, 'plugins', 'offload-worker');
  const destination = join(home, 'codex', 'skills');
  const globalSkills = join(config, 'skills');
  for (const directory of [
    join(globalSkills, 'shared'),
    join(globalSkills, '.system'),
    join(globalSkills, 'custom'),
    join(worker, 'skills', 'shared'),
    join(worker, 'skills', 'bundled'),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(join(directory, 'SKILL.md'), '');
  }
  fs.mkdirSync(join(destination, 'custom'), { recursive: true });
  fs.copyFileSync(join(__dirname, '..', 'sync-skills.cjs'), join(worker, 'sync-skills.cjs'));
  const mock = join(home, 'mock-links.cjs');
  fs.writeFileSync(mock, `
    const fs = require('node:fs');
    fs.symlinkSync = (source, target, type) => {
      fs.mkdirSync(target);
      fs.writeFileSync(require('node:path').join(target, 'link.json'), JSON.stringify({ source, type }));
    };
  `);
  const { command, args } = require('../mcp_config.json').mcpServers['offload-worker'];
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, 'codex') };
  for (let run = 0; run < 2; run++) {
    const result = spawnSync(command, ['--require', mock, ...args.slice(0, -1), '-e', 'console.log("server")'], {
      env,
      encoding: 'utf8',
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'server');
    assert.equal(result.stderr, '');
  }
  assert.deepEqual(fs.readdirSync(destination).sort(), ['bundled', 'custom', 'shared']);
  assert.deepEqual(fs.readdirSync(join(destination, 'custom')), []);
  for (const [name, source] of [
    ['shared', join(globalSkills, 'shared')],
    ['bundled', join(worker, 'skills', 'bundled')],
  ]) {
    assert.deepEqual(JSON.parse(fs.readFileSync(join(destination, name, 'link.json'), 'utf8')), {
      source: fs.realpathSync(source),
      type: process.platform === 'win32' ? 'junction' : 'dir',
    });
  }
});
