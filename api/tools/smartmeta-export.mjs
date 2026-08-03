/**
 * Converts Telo's Smart Report knowledge base (lib/report/smartMeta.ts, ~71 KB
 * of hand-written clinical copy for ~90 analytes) into JSON that the .NET API
 * embeds as a resource.
 *
 * Why convert rather than re-author: the content is the valuable part and was
 * sourced from consumer-health references with a deliberate tone. Hand-porting
 * it to C# would introduce transcription errors and immediately fork from the
 * source. Re-run this whenever Telo's file changes.
 *
 *   node tools/smartmeta-export.mjs [pathToSmartMeta.ts] [outJsonPath]
 *
 * MATCHERS / DEPARTMENT_FALLBACK are module-private in the source, so this
 * rewrites a COPY to export them before transpiling. Telo's file is never
 * modified.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const src = resolve(process.argv[2] ?? 'X:/Stellar Telo/telo-web/lib/report/smartMeta.ts');
const out = resolve(process.argv[3] ?? 'src/Infinity.Api/Resources/smart-meta.json');

const raw = await readFile(src, 'utf8');

// Expose the module-private tables. Anchored to line starts so a mention inside
// a comment or string cannot match.
const patched = raw
  .replace(/^const MATCHERS\b/m, 'export const MATCHERS')
  .replace(/^const DEPARTMENT_FALLBACK\b/m, 'export const DEPARTMENT_FALLBACK');

for (const name of ['MATCHERS', 'DEPARTMENT_FALLBACK']) {
  if (!patched.includes(`export const ${name}`)) {
    throw new Error(`Could not expose ${name} — smartMeta.ts has changed shape; update this script.`);
  }
}

// Relative to this script, not the cwd — so it runs the same from api/ or tools/.
const here = dirname(fileURLToPath(import.meta.url));
const tmpTs = resolve(here, '.smartmeta.tmp.ts');
const tmpJs = resolve(here, '.smartmeta.tmp.mjs');
await writeFile(tmpTs, patched, 'utf8');

await build({
  entryPoints: [tmpTs],
  outfile: tmpJs,
  bundle: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
});

const mod = await import(pathToFileURL(tmpJs).href);

/** RegExp is not JSON — carry source + flags so .NET can rebuild it. */
const re = (r) => ({ pattern: r.source, flags: r.flags });

const payload = {
  generatedFrom: src.replace(/\\/g, '/'),
  categories: mod.SMART_CATEGORIES.map((c) => ({
    id: c.id, title: c.title, tagline: c.tagline, about: c.about ?? null,
  })),
  categoryAdvice: mod.CATEGORY_ADVICE,
  categoryAdviceDirectional: mod.CATEGORY_ADVICE_DIR,
  categoryAdviceOk: mod.CATEGORY_ADVICE_OK,
  departmentFallback: mod.DEPARTMENT_FALLBACK.map(([r, cat]) => ({ ...re(r), categoryId: cat })),
  matchers: mod.MATCHERS.map((m) => ({
    ...re(m.name),
    codes: m.codes ?? null,
    info: {
      name: m.info.name ?? null,
      categoryId: m.info.categoryId,
      what: m.info.what ?? null,
      high: m.info.high ?? null,
      low: m.info.low ?? null,
      advice: m.info.advice ?? null,
      adviceHigh: m.info.adviceHigh ?? null,
      adviceLow: m.info.adviceLow ?? null,
      adviceOk: m.info.adviceOk ?? null,
    },
  })),
};

await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(payload, null, 1), 'utf8');

const withCodes = payload.matchers.filter((m) => m.codes?.length).length;
console.log(`categories        : ${payload.categories.length}`);
console.log(`matchers          : ${payload.matchers.length} (${withCodes} with explicit codes)`);
console.log(`department rules  : ${payload.departmentFallback.length}`);
console.log(`wrote             : ${out}`);
