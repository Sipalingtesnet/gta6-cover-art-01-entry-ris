// VICE COVER STUDIO hands itself in: the whole app is app/ (plain static files a desktop browser opens
// offline) and the judge's evidence is screenshots/. This program copies both, unchanged and in name order,
// into the output directory (the grader's /output, or MAKEFUN_OUTPUT_DIR when run by hand) and then writes
// dossier.json with the vendored make.fun library, so the judge reads the same bytes the repository holds.
//
// Run it with:  mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// Serve the app with:  node serve.ts   (then open http://localhost:8080)

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-app.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(out, { recursive: true });

// Copy app/ whole. Screenshots are copied file by file after clearing the old ones, so a stale render from an
// earlier run can never ride along into the dossier (the judge's cover is simply the first name in that folder).
cpSync(join(here, 'app'), join(out, 'app'), { recursive: true });

const shotsOut = join(out, 'screenshots');
rmSync(shotsOut, { recursive: true, force: true });
mkdirSync(shotsOut, { recursive: true });
const shotsIn = join(here, 'screenshots');
if (existsSync(shotsIn)) {
  for (const name of readdirSync(shotsIn, { withFileTypes: true })) {
    if (name.isFile() && !name.name.startsWith('.')) cpSync(join(shotsIn, name.name), join(shotsOut, name.name));
  }
}

// The scorer's caps, as the starter's program sets them: text_max_bytes shapes the dossier's bytes, and the
// rest refuse an entry the scorer would refuse anyway (4 screenshots of 256 KiB, 993 app entries, 48 MiB).
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    app_max_files: 993,
    app_max_bytes: 50331648,
    app_path_max_bytes: 1000,
  }),
);

console.log(`wrote ${out}/app, ${out}/screenshots and ${out}/dossier.json`);
