/**
 * Replace fenced code blocks (```...``` / ~~~...~~~) and inline code spans
 * (`...`) with equal-length runs of spaces. Character offsets are preserved,
 * so a match found in the masked text can be spliced back into the original,
 * while markdown syntax quoted in code is never treated as a real chip or
 * transclusion.
 *
 * The SQL link trigger has a behaviorally identical implementation; keep them
 * in sync if you change this.
 */
export function maskCodeRegions(content: string): string {
  if (!content) return content;
  let out = '';
  let i = 0;
  const n = content.length;
  while (i < n) {
    const lineStart = i === 0 || content[i - 1] === '\n';
    if (lineStart) {
      let j = i;
      while (j < n && (content[j] === ' ' || content[j] === '\t')) j++;
      const ch = content[j];
      if ((ch === '`' || ch === '~') && content[j + 1] === ch && content[j + 2] === ch) {
        const fenceChar = ch;
        let fenceLength = 0;
        while (content[j + fenceLength] === fenceChar) fenceLength++;
        let lineEnd = content.indexOf('\n', j);
        if (lineEnd === -1) lineEnd = n;
        for (let k = i; k < lineEnd; k++) {
          out += content[k] === '\n' ? '\n' : ' ';
        }
        if (lineEnd < n) out += '\n';
        let k = lineEnd + 1;
        while (k < n) {
          let lineEnd2 = content.indexOf('\n', k);
          if (lineEnd2 === -1) lineEnd2 = n;
          let p = k;
          while (p < n && (content[p] === ' ' || content[p] === '\t')) p++;
          // Only a bare run of the fence character, at least as long as the
          // opening one, closes it; "```js" inside code is just code.
          let run = 0;
          while (content[p + run] === fenceChar) run++;
          const rest = content.slice(p + run, lineEnd2);
          if (run >= fenceLength && /^[ \t\r]*$/.test(rest)) {
            for (let q = k; q < lineEnd2; q++) {
              out += content[q] === '\n' ? '\n' : ' ';
            }
            if (lineEnd2 < n) out += '\n';
            k = lineEnd2 + 1;
            break;
          }
          for (let q = k; q < lineEnd2; q++) {
            out += content[q] === '\n' ? '\n' : ' ';
          }
          if (lineEnd2 < n) out += '\n';
          k = lineEnd2 + 1;
        }
        i = k;
        continue;
      }
    }
    if (content[i] === '`') {
      let runLen = 0;
      while (i + runLen < n && content[i + runLen] === '`') runLen++;
      let j = i + runLen;
      let foundEnd = -1;
      while (j < n) {
        if (content[j] === '`') {
          let closeLen = 0;
          while (j + closeLen < n && content[j + closeLen] === '`') closeLen++;
          if (closeLen === runLen) {
            foundEnd = j + closeLen;
            break;
          }
          j += closeLen;
        } else {
          j++;
        }
      }
      if (foundEnd !== -1) {
        for (let k = i; k < foundEnd; k++) {
          out += content[k] === '\n' ? '\n' : ' ';
        }
        i = foundEnd;
        continue;
      }
    }
    out += content[i];
    i++;
  }
  return out;
}
