// Diff ligne à ligne (LCS) avec repli rapide pour les très gros documents.

export function diffLines(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const A = a.slice(s, ea);
  const B = b.slice(s, eb);
  const mid = A.length * B.length <= 4_000_000 ? lcs(A, B) : approx(A, B);

  const ops = [];
  for (let i = 0; i < s; i++) ops.push(['=', a[i]]);
  ops.push(...mid);
  for (let i = ea; i < a.length; i++) ops.push(['=', a[i]]);

  let added = 0;
  let removed = 0;
  let equal = 0;
  for (const [t] of ops) {
    if (t === '+') added++;
    else if (t === '-') removed++;
    else equal++;
  }
  const total = a.length + b.length;
  return { ops, added, removed, equal, similarity: total ? (2 * equal) / total : 1 };
}

function lcs(A, B) {
  const n = A.length;
  const m = B.length;
  if (!n) return B.map((l) => ['+', l]);
  if (!m) return A.map((l) => ['-', l]);
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = A[i] === B[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push(['=', A[i]]);
      i++;
      j++;
    } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) out.push(['-', A[i++]]);
    else out.push(['+', B[j++]]);
  }
  while (i < n) out.push(['-', A[i++]]);
  while (j < m) out.push(['+', B[j++]]);
  return out;
}

function approx(A, B) {
  const sa = new Set(A);
  const sb = new Set(B);
  return [...A.filter((l) => !sb.has(l)).map((l) => ['-', l]), ...B.filter((l) => !sa.has(l)).map((l) => ['+', l])];
}

/** Réduit les longues séries de lignes identiques pour l'affichage. Ajoute les numéros de ligne. */
export function collapse(ops, context = 3) {
  const keep = new Uint8Array(ops.length);
  ops.forEach(([t], i) => {
    if (t !== '=') for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = 1;
  });
  const out = [];
  let oldN = 0;
  let newN = 0;
  let skipped = 0;
  ops.forEach(([t, l], i) => {
    if (t !== '+') oldN++;
    if (t !== '-') newN++;
    if (keep[i]) {
      if (skipped) {
        out.push({ t: 'skip', n: skipped });
        skipped = 0;
      }
      out.push({ t, l, o: t === '+' ? null : oldN, n: t === '-' ? null : newN });
    } else skipped++;
  });
  if (skipped) out.push({ t: 'skip', n: skipped });
  return out;
}

/** Aperçu texte pour Telegram : quelques lignes +/-. */
export function preview(ops, max = 12, width = 140) {
  const lines = [];
  for (const [t, l] of ops) {
    if (t === '=') continue;
    if (lines.length >= max) {
      lines.push('…');
      break;
    }
    lines.push(`${t} ${l.length > width ? l.slice(0, width) + '…' : l}`);
  }
  return lines.join('\n');
}
