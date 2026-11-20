import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { browserPreview } from '../profiles/browser-preview';

interface ArtifactFile {
  path: string;
  sha256: string;
  size: number;
}

function listFiles(root: string, directory = root): ArtifactFile[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap<ArtifactFile>((entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return listFiles(root, absolute);
      const content = readFileSync(absolute);
      return [
        {
          path: path.relative(root, absolute).split(path.sep).join('/'),
          sha256: createHash('sha256').update(content).digest('hex'),
          size: statSync(absolute).size,
        },
      ];
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

const output = path.resolve(browserPreview.outputDirectory);
const bundle = path.resolve('dist/bundle');
const app = path.join(output, 'app');

rmSync(output, { force: true, recursive: true });
mkdirSync(output, { recursive: true });

try {
  renameSync(bundle, app);
} catch {
  cpSync(bundle, app, { recursive: true });
  rmSync(bundle, { force: true, recursive: true });
}

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const files = listFiles(app);
writeFileSync(
  path.join(output, 'manifest.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      profile: browserPreview.name,
      productName: browserPreview.productName,
      version: packageJson.version,
      nodeVersion: process.version,
      files,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
    },
    null,
    2
  )}\n`
);

console.log(`[build] ${browserPreview.productName} written to ${browserPreview.outputDirectory}`);
