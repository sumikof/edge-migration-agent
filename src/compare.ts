import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import pixelmatch from 'pixelmatch';
import { root, safeName, Config, saveJson } from './core.js';

type Result = { passed: boolean; captures: Record<string, string> };
export async function compare(config: Config, name: string): Promise<{ passed: boolean; reportPath: string }> {
  safeName(name);
  const ie = path.join(root, 'artifacts', 'ie', name);
  const edge = path.join(root, 'artifacts', 'edge', name);
  const output = path.join(root, 'artifacts', 'compare', name);
  fs.mkdirSync(output, { recursive: true });
  const ieRun = JSON.parse(fs.readFileSync(path.join(ie, 'result.json'), 'utf8')) as Result;
  const edgeRun = JSON.parse(fs.readFileSync(path.join(edge, 'result.json'), 'utf8')) as Result;
  const keys = [...new Set([...Object.keys(ieRun.captures), ...Object.keys(edgeRun.captures)])].sort();
  const textDiffs = keys.filter((key) => ieRun.captures[key] !== edgeRun.captures[key]);
  const pngFiles = fs.readdirSync(ie).filter((f) => f.endsWith('.png') && f !== 'failure.png');
  const images: Array<{file: string; status: string; diffRatio?: number; dimensions?: string}> = [];
  for (const file of pngFiles) {
    const rhs = path.join(edge, file);
    if (!fs.existsSync(rhs)) { images.push({ file, status: 'missing-edge' }); continue; }
    const a = sharp(path.join(ie, file));
    const b = sharp(rhs);
    const ma = await a.metadata(), mb = await b.metadata();
    if (ma.width !== mb.width || ma.height !== mb.height || !ma.width || !ma.height) {
      images.push({ file, status: 'different-size', dimensions: `${ma.width}x${ma.height} vs ${mb.width}x${mb.height}` });
      continue;
    }
    const width = ma.width, height = ma.height;
    const va = await a.ensureAlpha().raw().toBuffer();
    const vb = await b.ensureAlpha().raw().toBuffer();
    const diff = Buffer.alloc(width * height * 4);
    const count = pixelmatch(va, vb, diff, width, height, { threshold: config.visualDiffThreshold });
    await sharp(diff, { raw: { width, height, channels: 4 } }).png().toFile(path.join(output, `diff-${file}`));
    const ratio = count / (width * height);
    images.push({ file, status: ratio <= config.maxDiffRatio ? 'within-tolerance' : 'different', diffRatio: ratio });
  }
  for (const file of fs.readdirSync(edge).filter((f) => f.endsWith('.png') && f !== 'failure.png')) {
    if (!pngFiles.includes(file)) images.push({ file, status: 'missing-ie' });
  }
  const passed = ieRun.passed && edgeRun.passed && !textDiffs.length && images.every((img) => img.status === 'within-tolerance');
  const report = { scenario: name, passed, iePassed: ieRun.passed, edgePassed: edgeRun.passed, textDiffs,
    ieCaptures: ieRun.captures, edgeCaptures: edgeRun.captures, images };
  const reportPath = path.join(output, 'report.json');
  saveJson(reportPath, report);
  return { passed, reportPath };
}
