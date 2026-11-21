// Turns a copy of the bench project into a "real-world heavy" variant:
// MUI barrel imports + icons + CSS modules in components, MUI ThemeProvider test-utils, jest-dom in setup.
import fs from 'node:fs'; import path from 'node:path';
const root = process.argv[2];
const walk = d => fs.readdirSync(d,{withFileTypes:true}).flatMap(e => e.isDirectory()? walk(path.join(d,e.name)) : [path.join(d,e.name)]);
// 1) components: add MUI + icon + css module import
const icons = ['Delete','Add','Close','Search','Edit','Check','Info','Warning'];
let i=0;
for (const f of walk(path.join(root,'src/components')).filter(f=>f.endsWith('.tsx'))) {
  const base = path.basename(f,'.tsx');
  fs.writeFileSync(path.join(path.dirname(f), base+'.module.css'), `.root{display:flex;gap:4px;padding:8px}\n.title{font-weight:600;color:#333}\n.error{color:red}\n`);
  const icon = icons[i++ % icons.length];
  const hdr = `import { Box as __MuiBox, Button as __MuiButton, TextField as __MuiTextField, Tooltip as __MuiTooltip, Dialog as __MuiDialog } from '@mui/material';\nimport __Icon from '@mui/icons-material/${icon}';\nimport __styles from './${base}.module.css';\nexport const __heavy = [__MuiBox, __MuiButton, __MuiTextField, __MuiTooltip, __MuiDialog, __Icon, __styles];\n`;
  fs.writeFileSync(f, hdr + fs.readFileSync(f,'utf8'));
}
// 2) test-utils with MUI providers
fs.writeFileSync(path.join(root,'test/test-utils.tsx'), `import type { ReactElement, ReactNode } from 'react';
import { render as rtlRender, type RenderOptions } from '@testing-library/react';
import { ThemeProvider, createTheme, CssBaseline } from '@mui/material';
const theme = createTheme({ palette: { primary: { main: '#1976d2' } } });
function Providers({ children }: { children: ReactNode }) {
  return <ThemeProvider theme={theme}><CssBaseline />{children}</ThemeProvider>;
}
export * from '@testing-library/react';
export function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(ui, { wrapper: Providers, ...options });
}
`);
// 3) half the test files use test-utils
let n=0;
for (const f of walk(path.join(root,'test')).filter(f=>f.endsWith('.test.tsx'))) {
  let s = fs.readFileSync(f,'utf8');
  if (n++ % 2 === 0 && !/wrapper/.test(s)) s = s.replace(/from '@testing-library\/react'/, "from '../test-utils'");
  fs.writeFileSync(f, s);
}
// 4) setup: jest-dom
const setup = path.join(root,'test/setup.ts');
fs.writeFileSync(setup, "import '@testing-library/jest-dom/vitest';\n" + fs.readFileSync(setup,'utf8'));
console.log('heavified', root);
