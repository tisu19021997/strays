/*
 * Generates pets/bundled.json — the pets that ship with strays but are not part
 * of the team.
 *
 * The four animals are the story: each one is a bug you have personally met.
 * These five are guests, so they arrive switched off and the Pets window is where
 * you let one in.
 *
 * Grids are built here rather than typed, because every early mistake drawing a
 * pet was a row that was the wrong width. Run it and diff the JSON:
 *
 *   node pets/build.js
 *   node .claude/skills/strays-pet/scripts/preview.js pets/bundled.json <index>
 */
const W = 16;

/* centre a run of cells in a W-wide row */
const mid = (body) => {
  const pad = W - body.length;
  if (pad < 0 || pad % 2) throw new Error(`cannot centre "${body}" (${body.length}) in ${W}`);
  return '.'.repeat(pad / 2) + body + '.'.repeat(pad / 2);
};
/* sparse row: {columnIndex: char} — for anything not symmetrical */
const at = (cells) => {
  const s = '.'.repeat(W).split('');
  for (const [i, ch] of Object.entries(cells)) s[i] = ch;
  return s.join('');
};
/* a run of one char starting at a column */
const run = (start, n, ch) => {
  const o = {};
  for (let i = 0; i < n; i++) o[start + i] = ch;
  return o;
};

// ------------------------------------------------------------------- Yoda
/*
 * The ears are the whole read, and they only became ears when they reached the
 * outer columns at the eye line and tapered a row above and below. At columns
 * 1-3 they looked like notches cut out of a square head.
 */
const YODA_HEAD = (eyes) => [
  mid('hh1111hh'),
  mid('h111111h'),
  mid('221331133122'),
  '2222' + eyes + '2222',
  mid('221112211122'),
  mid('112kk211'),
  mid('222222'),
];
const YODA_BODY = (feet) => [
  at({ 0: 't', ...run(4, 8, 'r') }),
  at({ 0: 't', ...run(3, 4, 'r'), 7: 'b', 8: 'b', ...run(9, 4, 'r') }),
  at({ 0: 't', 2: '1', ...run(3, 4, 'r'), 7: 'b', 8: 'b', ...run(9, 4, 'r'), 13: '1' }),
  at({ 0: 't', ...run(3, 10, 'b') }),
  at({ 0: 't', ...run(2, 12, 'b') }),
  feet,
];

const YODA = {
  name: 'Yoda',
  speed: 14,
  phrases: [
    'Do or do not. There is no try.',
    'Compile, it does not.',
    'Much to learn, you still have.',
    'Patience. Thinking, the model is.',
    'Ready, the tests are not.',
    'Size matters not. Look at the diff.',
    'Fear leads to anger. Anger leads to force-push.',
    'Named this variable well, you have not.',
  ],
  palette: {
    1: '#a9c98d', 2: '#84a86a', 3: '#5e7f4a',
    r: '#a89275', b: '#7b6950', h: '#b9c0b4', t: '#6b4f38',
    k: '#17181c', w: '#f5f7fb',
  },
  grids: {
    walk1: [...YODA_HEAD('1wk11wk1'), ...YODA_BODY(at({ 0: 't', 3: '2', 4: '2', 11: '2', 12: '2' }))],
    walk2: [...YODA_HEAD('1wk11wk1'), ...YODA_BODY(at({ 0: 't', 5: '2', 6: '2', 9: '2', 10: '2' }))],
    sit: [
      ...YODA_HEAD('1kk11kk1'),
      mid('rrrrrrrrrr'), mid('1rrrrrrrrrrrr1'), mid('bbbbbbbbbbbbbb'), mid('2bbbbbbbbbbbb2'),
    ],
    sleep: [
      ...YODA_HEAD('1kk11kk1'),
      mid('rrrrrrrrrr'), mid('bbbbbbbbbbbb'), 'b'.repeat(W),
    ],
  },
};

// ------------------------------------------------------------------- Rick
/*
 * The hair is the silhouette: a wide fan with a notched top. Spikes are 2 cells
 * wide because a 1-cell spike is swallowed by the generated outline — the outline
 * is 8-connected, so single-cell gaps fill in solid.
 */
const RICK_HEAD = (eyes) => [
  at({ ...run(2, 2, 'h'), ...run(6, 2, 'h'), ...run(10, 2, 'h') }),
  at(run(2, 11, 'h')),
  // hair down the sides rather than a third full row of it: three made the head
  // a light mass with a face buried in the bottom of it
  mid('h111111h'),
  // four cells, not six. At six the unibrow stopped reading as a brow and became
  // a black bar across the whole face
  mid('11kkkk11'),
  mid(eyes),
  mid('11122111'),
  mid('112kk211'),
  mid('2222'),
];
const RICK_BODY = (legs, shoes) => [
  at(run(3, 10, 'c')),
  at({ 2: '1', ...run(3, 4, 'c'), 7: 'd', 8: 'd', ...run(9, 4, 'c'), 13: '1' }),
  at(run(2, 12, 'c')),
  legs,
  shoes,
];

const RICK = {
  name: 'Rick',
  speed: 34,
  phrases: [
    'Wubba lubba dub dub.',
    "It compiled. Ship it.",
    "Don't think about it.",
    'I turned myself into a daemon, Morty.',
    'Sometimes science is more art than science.',
    "That just sounds like tech debt with extra steps.",
    'Nobody reads the logs, Morty. Nobody.',
  ],
  palette: {
    1: '#e8c9a8', 2: '#cfa781',
    h: '#9fb0c8', c: '#eef1f6', d: '#c2c8d2', t: '#5a6473', e: '#3f4756',
    k: '#17181c', w: '#f5f7fb',
  },
  grids: {
    walk1: [
      ...RICK_HEAD('1wk11wk1'),
      ...RICK_BODY(
        at({ 4: 't', 5: 't', 10: 't', 11: 't' }),
        at({ ...run(3, 3, 'e'), ...run(10, 3, 'e') }),
      ),
    ],
    walk2: [
      ...RICK_HEAD('1wk11wk1'),
      ...RICK_BODY(
        at({ 5: 't', 6: 't', 9: 't', 10: 't' }),
        at({ ...run(4, 3, 'e'), ...run(9, 3, 'e') }),
      ),
    ],
    sit: [
      ...RICK_HEAD('1kk11kk1'),
      at(run(3, 10, 'c')),
      at({ 2: '1', ...run(3, 10, 'c'), 13: '1' }),
      at(run(2, 12, 'c')),
      at({ ...run(2, 3, 't'), ...run(11, 3, 't') }),
    ],
    sleep: [
      ...RICK_HEAD('1kk11kk1'),
      at(run(3, 10, 'c')),
      at(run(2, 12, 'c')),
      at(run(1, 14, 't')),
    ],
  },
};

// ------------------------------------------------------------------ Morty
const MORTY_HEAD = (eyes) => [
  mid('hhhhhh'),
  mid('hhhhhhhh'),
  mid('h111111h'),
  mid(eyes),
  mid('11122111'),   // without this the eyes and the mouth ran into one dark mass
  mid('112kk211'),
  mid('2222'),
];
const MORTY_BODY = (legs, shoes) => [
  at(run(4, 8, 'y')),
  at({ 2: '1', ...run(3, 10, 'y'), 13: '1' }),
  at(run(3, 10, 'y')),
  legs,
  shoes,
];

const MORTY = {
  name: 'Morty',
  speed: 26,
  phrases: [
    'Aw jeez.',
    'It worked on my machine?',
    "I-I don't think we should push this, Rick.",
    'Is it supposed to do that?',
    'Aw man, the tests are red again.',
    'Can we just revert it? Please?',
  ],
  palette: {
    1: '#e8c9a8', 2: '#cfa781',
    h: '#7a4a28', y: '#e8d24a', j: '#4a6b9e', e: '#4a3826',
    k: '#17181c', w: '#f5f7fb',
  },
  grids: {
    walk1: [
      ...MORTY_HEAD('1wk11wk1'),
      ...MORTY_BODY(
        at({ ...run(4, 3, 'j'), ...run(9, 3, 'j') }),
        at({ 4: 'e', 5: 'e', 10: 'e', 11: 'e' }),
      ),
    ],
    walk2: [
      ...MORTY_HEAD('1wk11wk1'),
      ...MORTY_BODY(
        at({ ...run(5, 3, 'j'), ...run(8, 3, 'j') }),
        at({ 5: 'e', 6: 'e', 9: 'e', 10: 'e' }),
      ),
    ],
    sit: [
      ...MORTY_HEAD('1kk11kk1'),
      at(run(4, 8, 'y')),
      at({ 2: '1', ...run(3, 10, 'y'), 13: '1' }),
      at(run(2, 12, 'j')),
      at({ ...run(2, 3, 'j'), ...run(11, 3, 'j') }),
    ],
    sleep: [
      ...MORTY_HEAD('1kk11kk1'),
      at(run(4, 8, 'y')),
      at(run(2, 12, 'y')),
      at(run(1, 14, 'j')),
    ],
  },
};

// -------------------------------------------------------------------- BMO
/*
 * A screen with a body around it. The face lives on the screen, so the eyes and
 * mouth are drawn in screen colour's negative rather than on skin — which is why
 * the palette has a light `s` for the display and the dark outline does the rest.
 */
const BMO_FACE = (eyes, mouth) => [
  at(run(3, 10, 'm')),
  at({ 2: 'm', 3: 'm', ...run(4, 8, 's'), 12: 'm', 13: 'm' }),
  at({ 2: 'm', 3: 'm', ...run(4, 8, 's'), ...eyes, 12: 'm', 13: 'm' }),
  at({ 2: 'm', 3: 'm', ...run(4, 8, 's'), ...mouth, 12: 'm', 13: 'm' }),
  // the arms, which are the only thing that leaves the box
  at({ 0: 'm', 1: 'm', ...run(2, 12, 'm'), 14: 'm', 15: 'm' }),
];
const BMO_BODY = [
  at({ ...run(2, 12, 'm'), 6: 'b', 9: 'p' }),   // two buttons, and they are the only colour
  at(run(2, 12, 'm')),
  at(run(2, 12, 'n')),
];

const BMO = {
  name: 'BMO',
  speed: 20,
  phrases: [
    'beep. still here.',
    'Who wants to play a game?',
    'I am a real boy.',
    'Do you want to hear a joke about a race condition?',
    'I made you a save file.',
    'Oh no. Oh no. Oh... no, it is fine.',
  ],
  palette: {
    m: '#8fd9c8', n: '#5fae9c', s: '#e4f2ec',
    b: '#5aa9e6', p: '#e8788f',
    k: '#17181c', w: '#f5f7fb',
  },
  grids: {
    walk1: [
      ...BMO_FACE({ 6: 'k', 9: 'k' }, { 7: 'k', 8: 'k' }),
      ...BMO_BODY,
      at({ 4: 'm', 5: 'm', 10: 'm', 11: 'm' }),
      at({ ...run(3, 3, 'n'), ...run(10, 3, 'n') }),
    ],
    walk2: [
      ...BMO_FACE({ 6: 'k', 9: 'k' }, { 7: 'k', 8: 'k' }),
      ...BMO_BODY,
      at({ 5: 'm', 6: 'm', 9: 'm', 10: 'm' }),
      at({ ...run(4, 3, 'n'), ...run(9, 3, 'n') }),
    ],
    // sitting down is the screen going quiet: eyes narrow, mouth flat
    sit: [
      ...BMO_FACE({ 5: 'k', 6: 'k', 9: 'k', 10: 'k' }, { 7: 'k', 8: 'k' }),
      ...BMO_BODY,
      at(run(3, 10, 'n')),
    ],
    sleep: [
      ...BMO_FACE({ 5: 'k', 6: 'k', 9: 'k', 10: 'k' }, {}),
      ...BMO_BODY,
      at(run(2, 12, 'n')),
    ],
  },
};

// ------------------------------------------------------------- SpongeBob
/*
 * Square, and the holes are what stop the square reading as a brick. `o` is the
 * darker yellow: two-cell holes, because a one-cell hole is eaten by the outline.
 */
const SPONGE_HEAD = (eyes, mouth) => [
  at({ ...run(3, 10, 'y'), 5: 'o', 6: 'o', 10: 'o' }),
  at({ ...run(2, 12, 'y'), 4: 'o', 11: 'o', 12: 'o' }),
  at({ ...run(2, 12, 'y'), ...run(4, 3, 'w'), ...run(9, 3, 'w') }),
  at({ ...run(2, 12, 'y'), ...run(4, 3, 'w'), ...run(9, 3, 'w'), ...eyes }),
  at({ ...run(2, 12, 'y'), 5: 'w', 10: 'w', 7: 'o', 8: 'o' }),
  at({ ...run(2, 12, 'y'), ...mouth }),
  at({ ...run(3, 10, 'y'), 6: 'o', 9: 'o' }),
];
const SPONGE_BODY = (legs, shoes) => [
  at({ ...run(3, 10, 's'), 7: 'r', 8: 'r' }),
  at({ 2: 'y', ...run(3, 10, 's'), 7: 'r', 8: 'r', 13: 'y' }),
  at(run(3, 10, 't')),
  legs,
  shoes,
];

const SPONGEBOB = {
  name: 'SpongeBob',
  speed: 30,
  phrases: [
    "I'm ready! I'm ready!",
    'Is mayonnaise a config option?',
    'F is for friends who test together.',
    'The inner machinations of my mind are an enigma.',
    'I wumbo, you wumbo, we all wumbo.',
    'Two hours later…',
  ],
  palette: {
    y: '#f2d94e', o: '#d1b62f',
    s: '#eeeee4', t: '#8a6a3a', r: '#cf3b3b', e: '#4a3826',
    k: '#17181c', w: '#f8f8f2', b: '#5aa9e6',
  },
  grids: {
    walk1: [
      ...SPONGE_HEAD({ 5: 'k', 10: 'k' }, { ...run(6, 4, 'k'), 7: 'w', 8: 'w' }),
      ...SPONGE_BODY(
        at({ 4: 'y', 5: 'y', 10: 'y', 11: 'y' }),
        at({ ...run(3, 3, 'e'), ...run(10, 3, 'e') }),
      ),
    ],
    walk2: [
      ...SPONGE_HEAD({ 5: 'k', 10: 'k' }, { ...run(6, 4, 'k'), 7: 'w', 8: 'w' }),
      ...SPONGE_BODY(
        at({ 5: 'y', 6: 'y', 9: 'y', 10: 'y' }),
        at({ ...run(4, 3, 'e'), ...run(9, 3, 'e') }),
      ),
    ],
    sit: [
      ...SPONGE_HEAD({ 5: 'k', 10: 'k' }, { ...run(6, 4, 'k') }),
      at({ ...run(3, 10, 's'), 7: 'r', 8: 'r' }),
      at({ 2: 'y', ...run(3, 10, 's'), 13: 'y' }),
      at(run(2, 12, 't')),
      at({ ...run(2, 3, 'y'), ...run(11, 3, 'y') }),
    ],
    sleep: [
      ...SPONGE_HEAD({ ...run(4, 3, 'k'), ...run(9, 3, 'k') }, { 7: 'o', 8: 'o' }),
      at({ ...run(3, 10, 's'), 7: 'r', 8: 'r' }),
      at(run(2, 12, 't')),
      at(run(1, 14, 't')),
    ],
  },
};

// ----------------------------------------------------------------- output
const PETS = [YODA, RICK, MORTY, BMO, SPONGEBOB];

for (const pet of PETS) {
  for (const [name, rows] of Object.entries(pet.grids)) {
    rows.forEach((row, i) => {
      if (row.length !== W) throw new Error(`${pet.name}.${name} row ${i}: width ${row.length} != ${W}`);
      for (const ch of row) {
        if (ch !== '.' && !(ch in pet.palette)) {
          throw new Error(`${pet.name}.${name} row ${i}: "${ch}" is not in the palette`);
        }
      }
    });
  }
}

require('fs').writeFileSync(
  require('path').join(__dirname, 'bundled.json'),
  JSON.stringify(PETS, null, 2) + '\n',
);
console.log(PETS.map((p) => `${p.name} ${W}x${p.grids.walk1.length}`).join('  '));
