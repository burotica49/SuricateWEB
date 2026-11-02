// ZIP « store » (sans compression) : les plugins sont livrés sans dépendance npm.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};

/** Date DOS figée : l'archive ne change pas d'un octet si les fichiers n'ont pas changé. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.DS_Store') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile()) out.push(p);
  }
  return out;
}

/**
 * Archive le dossier `dir`. Chaque entrée est préfixée par `rootName`
 * (WordPress et PrestaShop attendent un dossier `vigieweb/` à la racine du zip).
 */
export function zipDirectory(dir, rootName) {
  const files = walk(dir).sort();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const rel = relative(dir, file).split(sep).join('/');
    const name = Buffer.from(`${rootName}/${rel}`);
    const data = readFileSync(file);
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralDir.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, centralDir, end]);
}
