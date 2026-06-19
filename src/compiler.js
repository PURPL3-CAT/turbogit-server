const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');

const ensureDirectory = async (dir) => {
  await fs.mkdir(dir, { recursive: true });
};

const exists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const listDirs = async (root) => {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: path.join(root, entry.name) }));
};

const listFiles = async (dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name }));
};

const readTextFile = async (dir, filename) => {
  const filePath = path.join(dir, filename);
  return fs.readFile(filePath, 'utf8');
};

const readBinaryFile = async (dir, filename) => {
  const filePath = path.join(dir, filename);
  return fs.readFile(filePath);
};

const getFileIfExists = async (dir, filename) => {
  const filePath = path.join(dir, filename);
  return (await exists(filePath)) ? filePath : null;
};

const getDirIfExists = async (dir, name) => {
  const candidate = path.join(dir, name);
  return (await exists(candidate) && (await fs.stat(candidate)).isDirectory()) ? candidate : null;
};

const md5 = async (data) => {
  return crypto.createHash('md5').update(data).digest('hex');
};

const normalizeBlocks = (blocks) => {
  if (!blocks || typeof blocks !== 'object') return;

  for (const bid of Object.keys(blocks)) {
    const blk = blocks[bid];
    if (!blk || typeof blk !== 'object') continue;

    if (blk.inputs && typeof blk.inputs === 'object') {
      for (const iname of Object.keys(blk.inputs)) {
        const ival = blk.inputs[iname];
        if (!Array.isArray(ival) && ival && typeof ival === 'object') {
          const ref = ival.block ?? ival.shadow ?? null;
          if (ref) {
            blk.inputs[iname] = [1, ref];
          } else if (Array.isArray(ival.value)) {
            blk.inputs[iname] = ival.value;
          } else {
            blk.inputs[iname] = [];
          }
        }
      }
    }

    if (blk.fields && typeof blk.fields === 'object') {
      for (const fname of Object.keys(blk.fields)) {
        const fval = blk.fields[fname];
        if (!Array.isArray(fval) && fval && typeof fval === 'object') {
          blk.fields[fname] = [fval.value ?? null, fval.id ?? null];
        }
      }
    }

    if (typeof blk.x === 'string') {
      const parsedX = parseFloat(blk.x);
      blk.x = Number.isFinite(parsedX) ? parsedX : 0;
    }
    if (typeof blk.y === 'string') {
      const parsedY = parseFloat(blk.y);
      blk.y = Number.isFinite(parsedY) ? parsedY : 0;
    }
    if (typeof blk.topLevel !== 'boolean') {
      blk.topLevel = Boolean(blk.topLevel);
    }
    if (typeof blk.shadow !== 'boolean') {
      blk.shadow = Boolean(blk.shadow);
    }
  }
};

const inferCostumeMeta = async (costumesDir) => {
  const files = await listFiles(costumesDir);
  if (files.length === 0) {
    throw new Error(`No costume files found in ${costumesDir}`);
  }

  return files.map(({ name }) => {
    const ext = path.extname(name).slice(1);
    const base = path.basename(name, path.extname(name));
    return {
      name: base,
      dataFormat: ext,
      rotationCenterX: 0,
      rotationCenterY: 0,
    };
  });
};

const inferSoundMeta = async (soundsDir) => {
  const files = await listFiles(soundsDir);
  return files.map(({ name }) => {
    const ext = path.extname(name).slice(1).toLowerCase();
    const base = path.basename(name, path.extname(name));
    return {
      name: base,
      dataFormat: ext,
      rate: 44100,
      sampleCount: 0,
    };
  });
};

const compileToSb3 = async (root) => {
  const spriteDirs = (await listDirs(root)).filter((d) => !d.name.startsWith('.'));
  spriteDirs.sort((a, b) => {
    if (a.name === 'Stage') return -1;
    if (b.name === 'Stage') return 1;
    return 0;
  });

  const project = {
    meta: {
      semver: '3.0.0',
      vm: '0.2.0',
      agent: 'custom',
    },
    targets: [],
    monitors: [],
    extensions: [],
  };

  const extensionsFile = await getFileIfExists(root, 'extensions.json');
  if (extensionsFile) {
    try {
      const extensionsText = await fs.readFile(extensionsFile, 'utf8');
      const extensionSources = JSON.parse(extensionsText);
      if (Array.isArray(extensionSources)) {
        project.extensions = extensionSources;
      } else {
        console.warn('[TurboGit] extensions.json did not contain an array, ignoring');
      }
    } catch (err) {
      console.warn('[TurboGit] failed to read extensions.json, ignoring', err);
    }
  }

  const assets = [];

  for (const { name: spriteName, path: spriteDir } of spriteDirs) {
    const blocksText = await readTextFile(spriteDir, 'blocks.json');
    const { blocks } = JSON.parse(blocksText);

    try {
      normalizeBlocks(blocks);
    } catch (err) {
      console.warn(`[TurboGit] failed to normalize blocks for ${spriteName}`, err);
    }

    const costumesDir = await getDirIfExists(spriteDir, 'costumes');
    if (!costumesDir) {
      throw new Error(`Missing costumes directory for sprite ${spriteName}`);
    }

    let costumeMeta;
    const costumeMetaFile = await getFileIfExists(costumesDir, 'costumes.json');
    if (costumeMetaFile) {
      costumeMeta = JSON.parse(await fs.readFile(costumeMetaFile, 'utf8'));
      if (!Array.isArray(costumeMeta)) {
        throw new Error(`Invalid costumes.json in ${spriteName}`);
      }
    } else {
      costumeMeta = await inferCostumeMeta(costumesDir);
    }

    const costumes = [];
    for (const meta of costumeMeta) {
      const filename = `${meta.name}.${meta.dataFormat}`;
      const data = await readBinaryFile(costumesDir, filename);
      const assetId = await md5(data);
      const md5ext = `${assetId}.${meta.dataFormat}`;
      assets.push({ md5ext, data });
      costumes.push({
        assetId,
        md5ext,
        dataFormat: meta.dataFormat,
        name: meta.name,
        rotationCenterX: meta.rotationCenterX ?? 0,
        rotationCenterY: meta.rotationCenterY ?? 0,
      });
    }

    const soundsDir = await getDirIfExists(spriteDir, 'sounds');
    let soundMeta = [];
    if (soundsDir) {
      const soundsMetaFile = await getFileIfExists(soundsDir, 'sounds.json');
      if (soundsMetaFile) {
        soundMeta = JSON.parse(await fs.readFile(soundsMetaFile, 'utf8'));
        if (!Array.isArray(soundMeta)) {
          throw new Error(`Invalid sounds.json in ${spriteName}`);
        }
      } else {
        soundMeta = await inferSoundMeta(soundsDir);
      }
    }

    const sounds = [];
    for (const meta of soundMeta) {
      const candidateNames = [`${meta.name}.wav`, `${meta.name}.mp3`];
      let data;
      let ext;

      for (const candidate of candidateNames) {
        try {
          data = await readBinaryFile(soundsDir, candidate);
          ext = path.extname(candidate).slice(1).toLowerCase();
          break;
        } catch (err) {
          // continue to next candidate
        }
      }

      if (!data) {
        throw new Error(`Missing sound file for ${spriteName}/${meta.name}`);
      }

      const assetId = await md5(data);
      const md5ext = `${assetId}.${ext}`;
      assets.push({ md5ext, data });
      sounds.push({
        assetId,
        md5ext,
        dataFormat: ext,
        name: meta.name,
        rate: meta.rate,
        sampleCount: meta.sampleCount,
      });
    }

    const isStage = spriteName === 'Stage';
    const target = {
      isStage,
      name: spriteName,
      variables: {},
      lists: {},
      broadcasts: {},
      comments: {},
      blocks,
      costumes,
      sounds,
      currentCostume: 0,
      volume: 100,
      layerOrder: isStage ? 0 : 1,
      visible: true,
      tempo: isStage ? 60 : undefined,
      videoTransparency: isStage ? 50 : undefined,
      videoState: isStage ? 'on' : undefined,
      textToSpeechLanguage: isStage ? null : undefined,
    };

    if (!isStage) {
      target.x = 0;
      target.y = 0;
      target.size = 100;
      target.direction = 90;
      target.draggable = false;
      target.rotationStyle = 'all around';
    }

    project.targets.push(target);
  }

  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(project, null, 2));
  for (const asset of assets) {
    zip.file(asset.md5ext, asset.data);
  }

  return zip.generateAsync({ type: 'nodebuffer' });
};

module.exports = {
  compileToSb3,
  ensureDirectory,
  readTextFile,
  readBinaryFile,
  listDirs,
  listFiles,
};
