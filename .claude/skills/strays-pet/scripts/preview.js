/*
 * ASCII-preview a pet's grids with the outline the engine will generate.
 *
 * `#` is a cell strays will fill dark by itself. That is the whole reason this
 * exists: the outline is 8-connected, so a one-cell gap between two filled cells
 * comes out solid dark, and detail you meant to read as separate strands reads as
 * a dark band. Validates widths and palette keys on the way past.
 *
 *   node preview.js path/to/pet.json [petIndex]
 */
const defs = require(require('path').resolve(process.argv[2]));
const pet = Array.isArray(defs) ? defs[Number(process.argv[3] || 0)] : defs;

if (!pet || !pet.grids || !pet.palette) {
  console.error('not a pet def: needs grids + palette');
  process.exit(1);
}

const render = (grid, pal) => {
  const rows = grid.length, cols = grid[0].length;
  const filled = (r, c) =>
    r >= 0 && r < rows && c >= 0 && c < cols && grid[r][c] !== '.' && !!pal[grid[r][c]];
  const out = [];
  for (let r = -1; r <= rows; r++) {
    let line = '';
    for (let c = -1; c <= cols; c++) {
      if (filled(r, c)) { line += grid[r][c]; continue; }
      let edge = false;
      for (let dr = -1; dr <= 1 && !edge; dr++) {
        for (let dc = -1; dc <= 1 && !edge; dc++) {
          if ((dr || dc) && filled(r + dr, c + dc)) edge = true;
        }
      }
      line += edge ? '#' : ' ';
    }
    out.push(line);
  }
  return out.join('\n');
};

let bad = 0;
for (const [name, rows] of Object.entries(pet.grids)) {
  const w = rows[0].length;
  rows.forEach((row, i) => {
    if (row.length !== w) { console.log(`!! ${name} row ${i}: width ${row.length} != ${w}`); bad++; }
    for (const ch of row) {
      if (ch !== '.' && !(ch in pet.palette)) { console.log(`!! ${name} row ${i}: "${ch}" not in palette`); bad++; }
    }
  });
  console.log(`=== ${pet.name} · ${name} (${w}x${rows.length}) ===`);
  console.log(render(rows, pet.palette));
}
if (bad) { console.log(`\n${bad} problem(s) — fix before rendering`); process.exit(1); }
