#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const Packager = require('@turbowarp/packager');
const { compileToSb3, ensureDirectory } = require('../src/compiler');

const log = console.log;
const error = console.error;

const sanitizeName = (value) => {
  return value
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'turbogit-project';
};

const run = async () => {
  const [sourceDir, buildDir] = process.argv.slice(2);
  if (!sourceDir || !buildDir) {
    error('Usage: turbogit-server <source_dir> <build_dir>');
    process.exit(1);
  }

  const resolvedSource = path.resolve(sourceDir);
  const resolvedBuild = path.resolve(buildDir);

  const sourceStat = await fs.stat(resolvedSource).catch(() => null);
  if (!sourceStat || !sourceStat.isDirectory()) {
    error(`Source directory not found: ${resolvedSource}`);
    process.exit(1);
  }

  await ensureDirectory(resolvedBuild);

  const projectName = sanitizeName(path.basename(resolvedSource));
  const sb3Name = `${projectName}.sb3`;
  const htmlName = `${projectName}.html`;
  const sb3Path = path.join(resolvedBuild, sb3Name);
  const htmlPath = path.join(resolvedBuild, htmlName);

  log(`Compiling source directory: ${resolvedSource}`);
  const projectData = await compileToSb3(resolvedSource);
  await fs.writeFile(sb3Path, projectData);
  log(`Written SB3 to: ${sb3Path}`);

  log('Loading SB3 into TurboWarp packager...');
  const loadedProject = await Packager.loadProject(projectData);
  const packager = new Packager.Packager();
  packager.project = loadedProject;

  const result = await packager.package();
  if (result.type !== 'text/html') {
    error(`Unexpected packager output type: ${result.type}`);
    process.exit(1);
  }

  await fs.writeFile(htmlPath, result.data);
  log(`Written HTML output to: ${htmlPath}`);
  log('Done.');
};

run().catch((err) => {
  error('turbogit-server failed:', err);
  process.exit(1);
});
