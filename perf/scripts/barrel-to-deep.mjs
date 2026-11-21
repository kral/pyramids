// Test-only Vite plugin: rewrites `import { A, B as C } from '<barrel>'` into per-module deep imports.
// Generic: a named import X becomes `import X from '<pkg>/X'` if <pkg>/X exists as a subpath,
// else it is looked up in fallback sub-barrels (e.g. @mui/material/styles), else left on the barrel.
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
export default function barrelToDeep({ packages, root = process.cwd() }) {
  const req = createRequire(path.join(root, 'package.json'));
  const pkgDir = p => path.dirname(req.resolve(p + '/package.json'));
  const exists = new Map();
  const hasSub = (pkg, name) => {
    const k = pkg + '/' + name; if (exists.has(k)) return exists.get(k);
    const d = pkgDir(pkg); const v = fs.existsSync(path.join(d, name, 'index.mjs')) || fs.existsSync(path.join(d, name + '.mjs')) || fs.existsSync(path.join(d, name, 'index.js'));
    exists.set(k, v); return v;
  };
  const re = new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*['"](${Object.keys(packages).map(p=>p.replace(/[/]/g,'\\/')).join('|')})['"];?`, 'g');
  return {
    name: 'barrel-to-deep', enforce: 'pre',
    transform(code, id) {
      if (id.includes('node_modules') || !/\.[jt]sx?$/.test(id) || !re.test(code)) return; re.lastIndex = 0;
      return code.replace(re, (m, specs, pkg) => {
        const out = [], rest = [];
        for (const raw of specs.split(',').map(s=>s.trim()).filter(Boolean)) {
          const typeOnly = raw.startsWith('type ');
          const [imported, local = imported] = raw.replace(/^type\s+/, '').split(/\s+as\s+/).map(s=>s.trim());
          if (typeOnly) { continue; }
          const sub = packages[pkg].named?.[imported];
          if (sub) out.push(`import { ${imported} as ${local} } from '${pkg}/${sub}';`);
          else if (hasSub(pkg, imported)) out.push(`import ${local} from '${pkg}/${imported}';`);
          else rest.push(raw);
        }
        if (rest.length) out.push(`import { ${rest.join(', ')} } from '${pkg}';`);
        return out.join('\n');
      });
    },
  };
}
