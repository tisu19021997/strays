/*
 * strays — a tiny team of debugging pets.
 *
 *   Segfault   a cat. everything's fine, everything's fine, then SIGSEGV.
 *   Grep       a dog. finds everything, including things you didn't ask for.
 *   Mutex      a second cat. two cats cannot pass each other. deadlock.
 *   Heisenbug  a fish in a space helmet. only misbehaves when unobserved.
 *
 * Nothing on screen but the pets themselves — the one prop is Grep's ball,
 * and there is only ever one ball.
 *
 * Zero dependencies. Works as a <script> tag on any page, and as the
 * renderer for the desktop overlay in ./desktop.
 *
 *   Strays.mount({ party: true })
 *   Strays.setStatus('working' | 'needs-you' | 'idle' | null)
 *   Strays.setSessions([{ id, state: 'thinking'|'tool'|'waiting'|'done', cwd, title }])
 *   Strays.setShowTitles(false)  // pets carry state only, not a session name
 *   Strays.addCustomPet(def)     // see editor.html for the format
 *
 * MIT licensed. Draw your own pet in editor.html.
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- sprites
  // Pixel grids. '.' is transparent; every other char maps into the pet's
  // palette. '1'/'2'/'3' are light/mid/dark body tones, 'k' black, 'w' white,
  // 'p' pink, 's' stripes, 'n' nose. A 1px dark outline is generated
  // automatically around each sprite, so grids only carry the fill.

  const CAT = {
    walk1: [
      '.......11..11...',
      '.3.....11..11...',
      '3.111111111111..',
      '3111s1s1111111..',
      '3111111111wk1p..',
      '3222222222kk22..',
      '32s2s222222222..',
      '.3333333333333..',
      '..33.33.33..33..',
      '..33.33.33..33..',
    ],
    walk2: [
      '.......11..11...',
      '.3.....11..11...',
      '3.111111111111..',
      '3111s1s1111111..',
      '3111111111wk1p..',
      '3222222222kk22..',
      '32s2s222222222..',
      '.3333333333333..',
      '.33.33..33.33...',
      '.33.33..33.33...',
    ],
    sit: [
      '................',
      '.......11..11...',
      '..111111111111..',
      '.1111111111111..',
      '.111111111wk1p..',
      '.222222222kk22..',
      '.2222222222222..',
      '.3333333333333..',
      '.33333333333333.',
      '..333333333333..',
    ],
    sleep: [
      '................',
      '................',
      '.......11..11...',
      '..111111111111..',
      '.1111111111111..',
      '.111111111kk11..',
      '.2222222222222..',
      '32222222222222..',
      '.3333333333333..',
      '................',
    ],
    crashed: [
      '................',
      '................',
      '................',
      '................',
      '..33.33.........',
      '..111111111111..',
      '.111111111kk11..',
      '.22222222222p2..',
      '.3333333333333..',
      '................',
    ],
  };

  const DOG = {
    walk1: [
      '.........333....',
      '........13331...',
      '........111wk1..',
      '........111kk1nn',
      '.3111111111111nn',
      '..222222222222..',
      '..222222222222..',
      '..333333333333..',
      '..33.33.33..33..',
      '..33.33.33..33..',
    ],
    walk2: [
      '.........333....',
      '........13331...',
      '........111wk1..',
      '33......111kk1nn',
      '..111111111111nn',
      '..222222222222..',
      '..222222222222..',
      '..333333333333..',
      '.33..33..33.33..',
      '.33..33..33.33..',
    ],
    sniff: [
      '................',
      '..3.............',
      '..31111111......',
      '.3111111111.....',
      '..2222222211....',
      '..22222222133...',
      '..3333333311wk1.',
      '..33.33...111nn.',
      '..33.33....1nn..',
      '................',
    ],
    dig: [
      '................',
      '..3.............',
      '..31111111......',
      '.3111111111.....',
      '..2222222211....',
      '..22222222133...',
      '..3333333311wk1.',
      '..33.33..33111n.',
      '..3.3......1nn..',
      '................',
    ],
  };

  const FISH = {
    swim1: [
      '.....111..',
      '3....1111.',
      '33..111wk1',
      '333.222kk2',
      '33..22222.',
      '3....3333.',
      '.....33...',
    ],
    swim2: [
      '.....111..',
      '.3...1111.',
      '33..111wk1',
      '.33.222kk2',
      '33..22222.',
      '.3...3333.',
      '.....33...',
    ],
  };

  const BALL_GRID = ['.11.', '1121', '1211', '.11.'];
  const BALL_PAL = { 1: '#cbe94c', 2: '#eef7d0' };

  // Heisenbug's space helmet — pixelated like everything else. Palette colors
  // are rgba so the glass stays translucent; the auto-outline wraps the dome.
  const HELMET_GRID = [
    '....ggggg....',
    '..ggGGGGGgg..',
    '.gGhhGGGGGGg.',
    '.gGhGGGGGGGg.',
    'gGGGGGGGGGGGg',
    'gGGGGGGGGGGGg',
    'gGGGGGGGGGGGg',
    'gGGGGGGGGGGGg',
    'gGGGGGGGGGGGg',
    '.gGGGGGGGGGg.',
    '.gGGGGGGGGGg.',
    '..ggGGGGGgg..',
    '....ggggg....',
  ];
  const HELMET_CALM = { g: 'rgba(200,228,250,0.75)', G: 'rgba(150,200,240,0.16)', h: 'rgba(255,255,255,0.6)' };
  const HELMET_SPOOKED = { g: 'rgba(190,140,255,0.8)', G: 'rgba(160,95,230,0.22)', h: 'rgba(255,255,255,0.6)' };

  const OUTLINE = '#17181c';

  const PALETTES = {
    segfault: { 1: '#aab3c8', 2: '#8a93ad', 3: '#616b85', s: '#8a93ad', k: '#17181c', w: '#f5f7fb', p: '#e8a0a8' },
    mutex:    { 1: '#ffd166', 2: '#f0a63f', 3: '#c47c2b', s: '#b5641f', k: '#17181c', w: '#f5f7fb', p: '#e8a0a8' },
    grep:     { 1: '#d9a878', 2: '#bd8455', 3: '#8a5a33', n: '#17181c', k: '#17181c', w: '#f5f7fb' },
    heisenbug:{ 1: '#ffb26b', 2: '#ff8f4d', 3: '#d96a30', k: '#17181c', w: '#f5f7fb' },
  };

  /*
   * The red and blue ghosts of Segfault's pre-crash glitch. Module-level, and
   * that is load-bearing rather than tidy: the sprite cache is keyed by a
   * lazily-assigned id per palette object, so writing these inline at the call
   * site minted a new key — and a new offscreen canvas, kept forever — on every
   * frame of every crash. See spriteBitmap.
   */
  const GLITCH_RED = { 1: '#ff5f56', 2: '#ff5f56', 3: '#c33', s: '#ff5f56', k: '#600', w: '#fff', p: '#f99' };
  const GLITCH_BLUE = { 1: '#57c7ff', 2: '#57c7ff', 3: '#38a', s: '#57c7ff', k: '#036', w: '#fff', p: '#9cf' };

  // -------------------------------------------------------------- utilities
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const GREP_FINDS = [
    './notes.md:41: TODO: fix this properly',
    'password.txt.bak (do not commit)',
    '3,412 matches. you asked for one.',
    'left_sock.o',
    '"temporary" hack, 4 years old',
    'node_modules (again)',
    '.env.production (uh oh)',
    'a race condition, slightly chewed',
    '// @ts-ignore x 87',
    'the bug. it was in YOUR code.',
  ];

  const SEGFAULT_LAST_WORDS = [
    'Segmentation fault (core dumped)',
    'signal 11 <3',
    'i regret nothing',
    '0xDEADBEEF',
  ];

  const HEISENBUG_ALIBIS = [
    'everything is fine.',
    'i was floating normally.',
    'works in my helmet.',
    'cannot reproduce.',
  ];

  const USAGE_LINES = [
    'that\'s $COST today. i saw nothing.',
    'the tokens climb when you\'re not looking. $COST.',
    '$COST. cannot reproduce the invoice.',
    'anomaly detected in your wallet: $COST.',
  ];

  function fmtTokens(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'k';
    return String(n);
  }

  // `resting` is a session you still have open that is not asking for
  // anything — it keeps its pet and its name, but does not hop or nag.
  const STATE_GLYPHS = { thinking: '💭', tool: '🔧', waiting: '❗', resting: '💤', done: '✓' };

  /*
   * How much of a session's name a pet carries. Eight pets share one lane a few
   * hundred pixels tall and the whole screen wide, so a name that runs long
   * stops being a glance and starts covering its neighbours.
   */
  const TITLE_CHARS = 18;

  // ------------------------------------------------------------ lane chrome
  /*
   * The labels above the pets are built out of the same material as the pets:
   * flat opaque fills, a 1px dark edge, corners knocked out by one pixel. The
   * one colour that is not fixed is the speech bubble, which takes the speaking
   * pet's own light tone — so who said it is a colour rather than a deduction.
   */
  const FONT = '11px ui-monospace, Menlo, monospace';
  const EDGE = '#0b0c10';      // the generated sprite outline, near enough
  const PLATE = '#14161c';     // nameplate fill
  const INK = '#e8ebf2';
  const INK_DIM = '#99a1b4';   // the hover detail line
  const WAIT_INK = '#ffb03a';  // a session that needs you
  const DONE_INK = '#7ddb63';

  const PLATE_H = 18;          // one line of chrome
  const LINE_H = 14;           // the hover line added beneath it
  const PLATE_PAD = 6;
  const GLYPH_BOX = 20;        // the square the state glyph sits in
  const PLATE_GAP = 5;         // between the pet's head and its nameplate
  const SPEECH_GAP = 3;        // between the nameplate and the speech above it
  const TAIL_H = 4;            // the pixel staircase under a speech bubble

  // ---------------------------------------------------- sprite cache/outline
  // Sprites render once to an offscreen canvas: fills first, then a 1px dark
  // outline around the silhouette (8-neighbour), Crew-style. Cache key is
  // (grid, palette, scale) via lazily-assigned ids.
  let _idc = 1;
  const spriteCache = new Map();

  function renderSpriteCanvas(grid, pal, scale) {
    const rows = grid.length, cols = grid[0].length;
    const cv = document.createElement('canvas');
    cv.width = (cols + 2) * scale;
    cv.height = (rows + 2) * scale;
    const c = cv.getContext('2d');
    const filled = (r, cc) =>
      r >= 0 && r < rows && cc >= 0 && cc < cols && grid[r][cc] !== '.' && !!pal[grid[r][cc]];
    for (let r = -1; r <= rows; r++) {
      for (let cc = -1; cc <= cols; cc++) {
        if (filled(r, cc)) {
          c.fillStyle = pal[grid[r][cc]];
          c.fillRect((cc + 1) * scale, (r + 1) * scale, scale, scale);
        } else {
          let edge = false;
          for (let dr = -1; dr <= 1 && !edge; dr++)
            for (let dc = -1; dc <= 1 && !edge; dc++)
              if ((dr || dc) && filled(r + dr, cc + dc)) edge = true;
          if (edge) {
            c.fillStyle = OUTLINE;
            c.fillRect((cc + 1) * scale, (r + 1) * scale, scale, scale);
          }
        }
      }
    }
    return cv;
  }

  /*
   * The cache is keyed by identity, not by content, so a caller that builds its
   * palette or grid inline gets a fresh key every single call. Four pets over a
   * handful of states need a few dozen entries; anything past the cap is a bug
   * of that shape, and dropping the cache bounds it at a slow frame instead of
   * a renderer that grows until canvas allocation fails and the lane dies.
   */
  const SPRITE_CACHE_MAX = 256;
  let cacheWarned = false;

  function spriteBitmap(grid, pal, scale) {
    if (!grid._k) Object.defineProperty(grid, '_k', { value: _idc++ });
    if (!pal._k) Object.defineProperty(pal, '_k', { value: _idc++ });
    const key = grid._k + ':' + pal._k + ':' + scale;
    let cv = spriteCache.get(key);
    if (!cv) {
      if (spriteCache.size >= SPRITE_CACHE_MAX) {
        spriteCache.clear();
        if (!cacheWarned) {
          cacheWarned = true;
          console.warn('strays: sprite cache overflowed — a caller is passing a new grid or palette object each frame');
        }
      }
      cv = renderSpriteCanvas(grid, pal, scale);
      spriteCache.set(key, cv);
    }
    return cv;
  }

  // draws with the sprite's (0,0) grid cell at (x,y); outline hangs outside
  function drawGrid(ctx, grid, pal, x, y, scale, flipX, sliceJitter) {
    const cv = spriteBitmap(grid, pal, scale);
    ctx.save();
    ctx.translate(x - scale, y - scale);
    if (flipX) { ctx.scale(-1, 1); ctx.translate(-cv.width, 0); }
    ctx.imageSmoothingEnabled = false;
    if (sliceJitter) {
      const slices = 4, sh = Math.ceil(cv.height / slices);
      for (let i = 0; i < slices; i++) {
        const off = rand(-2, 2) * scale * 0.6;
        ctx.drawImage(cv, 0, i * sh, cv.width, sh, off, i * sh, cv.width, sh);
      }
    } else {
      ctx.drawImage(cv, 0, 0);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ world
  function createWorld(opts) {
    return {
      opts,
      canvas: null, ctx: null,
      w: 0, h: 0, dpr: 1,
      pets: [], particles: [], bubbles: [], confetti: [],
      ball: { x: 0, y: 0, vx: 0, vy: 0, held: null },
      mouse: { x: -9999, y: -9999, active: false },
      grab: null,         // the pet currently under a press; see grabPet()
      observed: true,
      lastMouseMove: 0,
      badFrames: 0,      // frames the draw loop threw out of; see tick()
      status: null,       // legacy global status
      sessions: [],       // per-session states from the desktop watcher
      followMode: false,  // Crew-style: one visible pet per session
      showTitles: opts.showTitles !== false, // name the session a pet is carrying
      // null = work it out from the mouse (a web page); a boolean = the host
      // knows better, which the desktop overlay does
      observedOverride: null,
      mischief: opts.mischief !== false,     // Heisenbug wanders off when alone
      usage: null,        // today's token stats (Heisenbug is the usage tracker)
      costMilestone: null,
      anomalies: 0,
      recentCrash: -1e9,  // world.time of Segfault's last crash
      deadlockCd: rand(8, 18),
      deadlock: null,
      time: 0,
      hoverPet: null,
      raf: 0,
      destroyed: false,
    };
  }

  function spawnParticle(world, p) {
    world.particles.push(Object.assign({ age: 0, life: 1.2, vx: 0, vy: -20, size: 3 }, p));
  }

  function say(world, pet, text, life) {
    world.bubbles = world.bubbles.filter((b) => b.pet !== pet);
    world.bubbles.push({ pet, text, age: 0, life: life || 3 });
  }

  // ------------------------------------------------------------------- pets
  /*
   * A sprite set with the optional frames resolved.
   *
   * walk2, sit and sleep are documented as optional, falling back to walk1, and
   * the drawing code is entitled to take that literally. DOG defines neither sit
   * nor sleep, so Grep falling asleep selected `undefined` and threw out of the
   * render loop — which on a canvas means every pet silently vanishes and
   * nothing says why. Resolving the fallbacks once, here, is what makes the
   * documented contract true for built-in pets as well as custom ones.
   */
  function spriteSet(grids) {
    const walk1 = grids.walk1;
    return Object.assign({}, grids, {
      walk1,
      walk2: grids.walk2 || walk1,
      sit: grids.sit || walk1,
      sleep: grids.sleep || grids.sit || walk1,
    });
  }

  function makePet(world, kind, x) {
    const base = {
      kind, x, dir: Math.random() < 0.5 ? 1 : -1,
      state: 'walk', stateT: rand(1, 3),
      speed: 26, scale: world.opts.scale,
      frame: 0, frameT: 0, bob: 0,
      lift: 0, vx: 0, vy: 0, squirm: 0, tilt: 0,   // held or falling; see grabPet()
      name: kind, hat: world.opts.party,
      session: null,
    };
    if (kind === 'segfault') {
      Object.assign(base, { name: 'Segfault', sprites: spriteSet(CAT), pal: PALETTES.segfault, speed: 24, crashT: rand(14, 30) });
    } else if (kind === 'mutex') {
      Object.assign(base, { name: 'Mutex', sprites: spriteSet(CAT), pal: PALETTES.mutex, speed: 16, lazy: true });
    } else if (kind === 'grep') {
      Object.assign(base, { name: 'Grep', sprites: spriteSet(DOG), pal: PALETTES.grep, speed: 44, digT: rand(6, 14), carrying: null });
    } else if (kind === 'heisenbug') {
      Object.assign(base, {
        name: 'Heisenbug', sprites: spriteSet({ walk1: FISH.swim1, walk2: FISH.swim2 }),
        pal: PALETTES.heisenbug, state: 'swim', speed: 16,
        fy: 0, fdir: Math.random() < 0.5 ? 1 : -1, flipped: false, teleportT: rand(2, 5),
      });
    }
    return base;
  }

  // custom pets drawn in editor.html (or imported from images)
  function makeCustomPet(world, def, x) {
    return {
      kind: 'custom', custom: true,
      name: def.name || 'Pet',
      x, dir: Math.random() < 0.5 ? 1 : -1,
      state: 'walk', stateT: rand(1, 3),
      speed: def.speed || 28,
      scale: def.scale || world.opts.scale,
      frame: 0, frameT: 0, bob: 0,
      lift: 0, vx: 0, vy: 0, squirm: 0, tilt: 0,
      hat: world.opts.party,
      pal: def.palette,
      phrases: def.phrases || [],
      session: null,
      sprites: spriteSet(def.grids),
    };
  }

  function petWidth(pet) {
    return pet.sprites.walk1[0].length * pet.scale;
  }

  const floorY = (world) => world.h - 14;

  // how far above the floor Heisenbug hovers. The helmet is doing its job.
  const FISH_HOVER = 22;

  // ------------------------------------------------------------- pet update
  function updatePet(world, pet, dt) {
    pet.stateT -= dt;
    pet.frameT += dt;
    // legs scrabble in the air rather than walk: the same two frames, cycled
    // about three times as fast, which is most of what sells the panic
    const airborne = pet.state === 'held' || pet.state === 'falling';
    if (pet.frameT > (airborne ? squirmStyle(pet).step : 0.18)) {
      pet.frameT = 0; pet.frame = 1 - pet.frame;
    }

    const pw = petWidth(pet);

    // petting: cursor close to pet near the floor. This runs before the fish
    // hands off to its own update, because the fish is bindable too — a session
    // it holds is only reachable if the click reaches here.
    const near = Math.abs(world.mouse.x - (pet.x + pw / 2)) < pw * 0.7 &&
                 world.mouse.y > world.h - 90;
    if (near && world.mouse.active && pet.state !== 'crashed' && pet.state !== 'glitch') {
      if (!pet.petted) {
        pet.petted = true;
        spawnParticle(world, {
          x: pet.x + pw / 2, y: floorY(world) - (pet.kind === 'heisenbug' ? 84 : 40),
          glyph: '♥', color: '#ff6b81', vy: -26, life: 1.4,
        });
        if (pet.kind === 'grep') say(world, pet, 'woof. 1 match found: you', 2.2);
        else if (pet.kind === 'heisenbug') say(world, pet, pick(HEISENBUG_ALIBIS), 2.2);
        else if (pet.state !== 'deadlock') say(world, pet, pet.custom && pet.phrases.length ? pick(pet.phrases) : 'purr', 1.6);
      }
    } else pet.petted = false;

    // in hand, or on the way back down out of it. Both come before the fish
    // hands off to its own update for the same reason petting does: she can be
    // picked up like anyone else.
    if (pet.state === 'held') {
      if (world.grab && world.grab.pet === pet) return dragPet(world, pet, dt);
      pet.state = 'falling'; // the grab went away underneath it
    }
    if (pet.state === 'falling') return fallPet(world, pet, dt);

    if (pet.kind === 'heisenbug') return updateFish(world, pet, dt);

    const W = world.w;
    const busy = world.status === 'working' || (pet.session && (pet.session.state === 'thinking' || pet.session.state === 'tool'));
    const idle = world.status === 'idle';

    // a session that needs you makes its pet hop
    if (pet.session && pet.session.state === 'waiting' && pet.state !== 'glitch' && pet.state !== 'crashed') {
      pet.bob = -Math.abs(Math.sin(world.time * 6)) * 6;
    }

    // Segfault's scheduled crash
    if (pet.kind === 'segfault' && pet.state !== 'glitch' && pet.state !== 'crashed') {
      pet.crashT -= dt;
      if (pet.crashT <= 0) { pet.state = 'glitch'; pet.stateT = 1.1; }
    }

    // two cats cannot pass each other: proximity deadlock
    if ((pet.kind === 'segfault' || pet.kind === 'mutex') && pet.state === 'walk' && !world.deadlock && world.deadlockCd <= 0) {
      const other = world.pets.find((p) => p !== pet && (p.kind === 'segfault' || p.kind === 'mutex') && p.state === 'walk');
      if (other && Math.abs((pet.x + pw / 2) - (other.x + petWidth(other) / 2)) < 46) {
        startDeadlock(world, pet, other);
      }
    }

    switch (pet.state) {
      case 'walk': {
        const mult = busy ? 1.5 : idle ? 0.5 : 1;
        pet.x += pet.dir * pet.speed * mult * dt;
        if (!(pet.session && pet.session.state === 'waiting')) {
          pet.bob = Math.sin(world.time * 10) * 1.2;
        }
        if (pet.x < 6) { pet.x = 6; pet.dir = 1; }
        if (pet.x > W - pw - 6) { pet.x = W - pw - 6; pet.dir = -1; }

        if (pet.stateT <= 0) {
          pet.stateT = rand(1.5, 4);
          const r = Math.random();
          if (idle && r < 0.5) { pet.state = 'sleep'; pet.stateT = rand(5, 9); }
          else if (pet.lazy && r < 0.45) { pet.state = 'loaf'; pet.stateT = rand(8, 16); }
          else if (pet.lazy && r < 0.6) { pet.state = 'sleep'; pet.stateT = rand(6, 12); }
          else if (r < 0.25) { pet.state = 'sit'; pet.stateT = rand(2, 4); }
          else if (r < 0.5) pet.dir *= -1;
          if (pet.custom && pet.phrases.length && Math.random() < 0.12) {
            say(world, pet, pick(pet.phrases), 2.8);
          }
          if (pet.kind === 'grep') {
            pet.digT -= pet.stateT;
            const rr = Math.random();
            if (!world.ball.held && rr < 0.35) {
              pet.state = 'fetch'; pet.stateT = 8;
            } else if (pet.digT <= 0 || (busy && rr < 0.5)) {
              pet.state = 'sniff'; pet.stateT = 1.4; pet.digT = rand(8, 16);
            }
          }
        }
        break;
      }
      case 'sit': {
        pet.bob = pet.session && pet.session.state === 'waiting' ? pet.bob : 0;
        if (world.status === 'needs-you' && Math.random() < 0.02) {
          spawnParticle(world, { x: pet.x + pw / 2, y: floorY(world) - 46, glyph: '❗', color: '#ffb03a', vy: -14, life: 1 });
        }
        if (pet.stateT <= 0) { pet.state = 'walk'; pet.stateT = rand(2, 5); }
        break;
      }
      case 'sleep': {
        pet.bob = 0;
        if (Math.random() < 0.03) {
          spawnParticle(world, { x: pet.x + pw * 0.8, y: floorY(world) - 34, glyph: 'z', color: '#8b93a7', vy: -12, life: 2 });
        }
        // a lazy cat sleeps through the deploy
        if (pet.stateT <= 0 || (busy && !pet.lazy)) { pet.state = 'walk'; pet.stateT = rand(2, 5); }
        break;
      }
      case 'loaf': { // Mutex being extremely comfortable, apropos of nothing
        pet.bob = 0;
        if (Math.random() < 0.015) {
          spawnParticle(world, { x: pet.x + rand(0, pw), y: floorY(world) - rand(20, 44), glyph: '✦', color: '#ffd75e', vy: -8, life: 1.6 });
        }
        if (pet.stateT <= 0) { pet.state = 'walk'; pet.stateT = rand(2, 5); }
        break;
      }
      case 'deadlock': {
        pet.bob = 0; // frozen until the scheduler steps in
        break;
      }
      case 'sniff': {
        pet.x += pet.dir * 8 * dt;
        if (pet.stateT <= 0) { pet.state = 'dig'; pet.stateT = 2.4; }
        break;
      }
      case 'dig': {
        pet.bob = 0;
        if (Math.random() < 0.5) {
          spawnParticle(world, {
            x: pet.x + (pet.dir === 1 ? pw * 0.2 : pw * 0.8), y: floorY(world) - 6,
            rect: true, color: '#7c5433', vx: -pet.dir * rand(20, 60), vy: -rand(30, 70), life: 0.7, size: 3,
          });
        }
        if (pet.stateT <= 0) {
          if (world.time - world.recentCrash < 60 && Math.random() < 0.5) {
            say(world, pet, 'found: core.' + ((Math.random() * 9000 + 1000) | 0) + ' (still warm)', 3);
          } else {
            say(world, pet, 'found: ' + pick(GREP_FINDS), 3.2);
          }
          pet.state = 'walk'; pet.stateT = rand(2, 5);
        }
        break;
      }
      case 'fetch': { // Grep and the one (1) ball
        const ball = world.ball;
        const bc = ball.x, mc = pet.x + pw / 2;
        pet.dir = bc > mc ? 1 : -1;
        pet.x += pet.dir * pet.speed * 1.6 * dt;
        pet.bob = Math.sin(world.time * 14) * 1.6;
        pet.x = clamp(pet.x, 6, W - pw - 6);
        if (Math.abs(bc - mc) < pw * 0.4 && Math.abs(ball.vx) < 30 && ball.y >= floorY(world) - 8) {
          if (Math.random() < 0.6) {
            // nudge it and give chase
            ball.vx = pet.dir * rand(140, 240);
            ball.vy = -rand(80, 160);
            pet.stateT = Math.min(pet.stateT, rand(2, 5));
          } else {
            ball.held = pet; pet.carrying = 'ball';
            pet.carryT = rand(4, 8);
            say(world, pet, 'fetch complete. 1 result.', 2.2);
            pet.state = 'walk'; pet.stateT = rand(2, 5);
          }
        }
        if (pet.stateT <= 0) { pet.state = 'walk'; pet.stateT = rand(2, 5); }
        break;
      }
      case 'glitch': { // Segfault pre-crash
        pet.bob = rand(-2, 2);
        pet.x += rand(-40, 40) * dt;
        if (pet.stateT <= 0) {
          pet.state = 'crashed'; pet.stateT = 2.6;
          say(world, pet, pick(SEGFAULT_LAST_WORDS), 2.4);
          world.recentCrash = world.time;
        }
        break;
      }
      case 'crashed': {
        pet.bob = 0;
        if (pet.stateT <= 0) {
          pet.state = 'walk'; pet.stateT = rand(2, 4);
          pet.crashT = rand(18, 40);
          pet.x = rand(20, Math.max(40, world.w - pw - 20)); // respawns elsewhere, like nothing happened
        }
        break;
      }
    }

    if (pet.carrying && (pet.carryT -= dt) <= 0) {
      pet.carrying = null;
      if (world.ball.held === pet) {
        world.ball.held = null;
        world.ball.vx = pet.dir * 40;
        world.ball.vy = 0;
      }
    }
  }

  // ------------------------------------------------------ picking a pet up
  /*
   * A press that never travels is a click: the pet is petted, and a bound one
   * hands its session to onPetClick. Past DRAG_SLOP the same press is a drag
   * instead, and the click is cancelled — carrying a pet down the lane and
   * jumping into its conversation are different intentions, and firing both
   * would make every drag a navigation you did not ask for.
   *
   * That is also why the jump moved to the release. It used to fire the moment
   * the button went down, which cannot tell the two apart even in principle.
   */
  const DRAG_SLOP = 3;        // px of travel before a press becomes a drag
  const DROP_GRAVITY = 900;   // px/s² on the way back down
  const THROW_MAX = 520;      // px/s a fling can impart, on either axis
  const LAND_DUST = 6;

  /*
   * Nobody enjoys being picked up.
   *
   * `squirm` is how hard a pet is fighting the grip right now: all of it the
   * moment it leaves the floor, settling to a sulk, spiking again whenever it
   * is swung about and every so often for no reason at all — which is the part
   * that reads as fear rather than as an animation. `tilt` is the angle that
   * comes out, and the sprite is drawn turned by it.
   *
   * The two waves are not decoration either. One sine at one frequency is a
   * buzz; a second at an unrelated one is a creature that cannot decide which
   * way to twist.
   */
  const SQUIRM_SETTLE = 0.55;   // per second, down to a sulk
  const SQUIRM_SULK = 0.22;
  const SQUIRM_PANIC = 0.9;     // chance per second of remembering to panic
  const SQUIRM_STYLE = {
    // a cat twists fast and hard, a dog swings slower and wider, and a fish in
    // a helmet mostly vibrates
    cat: { hz: 13, tilt: 0.20, step: 0.055 },
    dog: { hz: 9, tilt: 0.15, step: 0.075 },
    fish: { hz: 18, tilt: 0.11, step: 0.05 },
    stray: { hz: 11, tilt: 0.17, step: 0.06 },
  };

  function squirmStyle(pet) {
    if (pet.kind === 'grep') return SQUIRM_STYLE.dog;
    if (pet.kind === 'heisenbug') return SQUIRM_STYLE.fish;
    if (pet.custom) return SQUIRM_STYLE.stray;
    return SQUIRM_STYLE.cat;
  }

  /* how hard it is struggling this frame, and which way that tips it */
  function updateSquirm(world, pet, dt, agitation) {
    const st = squirmStyle(pet);
    pet.squirm = Math.max(SQUIRM_SULK, pet.squirm - SQUIRM_SETTLE * dt);
    if (agitation > pet.squirm) pet.squirm = Math.min(1, agitation);
    if (Math.random() < SQUIRM_PANIC * dt) pet.squirm = 1;
    const t = world.time * st.hz;
    pet.tilt = (Math.sin(t) * 0.7 + Math.sin(t * 1.7 + 1) * 0.3) * st.tilt * pet.squirm;
  }

  /*
   * How high a pet can be carried: far enough to feel lifted, never far enough
   * for its own chrome to leave the lane. The nameplate hangs above the sprite
   * and grows a second line on hover, and the lane is a strip a couple of
   * hundred pixels tall — a pet held at the ceiling would wear a label clipped
   * off the top of the screen.
   */
  function liftCeiling(world, pet) {
    const sprite = pet.sprites.walk1.length * pet.scale +
                   (pet.kind === 'heisenbug' ? FISH_HOVER : 0);
    return Math.max(0, floorY(world) - sprite - (PLATE_GAP + PLATE_H + LINE_H));
  }

  /* the pet is in hand now, so whatever it was in the middle of is over */
  function grabPet(world, pet) {
    const g = world.grab;
    // measured here rather than at mousedown: the pet went on walking during
    // the press, and the point of the grab is that it does not jump on pickup
    g.dx = world.mouse.x - pet.x;
    g.dy = (floorY(world) - pet.lift) - world.mouse.y;

    if (world.deadlock && (world.deadlock.a === pet || world.deadlock.b === pet)) {
      const other = world.deadlock.a === pet ? world.deadlock.b : world.deadlock.a;
      other.state = 'walk'; other.stateT = rand(1, 3);
      world.deadlock = null;
    }
    if (world.ball.held === pet) { // you picked the dog up. the dog dropped the ball.
      world.ball.held = null;
      world.ball.vx = 0;
      pet.carrying = null;
    }
    pet.state = 'held';
    pet.bob = 0;
    pet.vx = 0; pet.vy = 0;
    pet.squirm = 1; // it fights hardest the moment its feet leave the floor
  }

  /* a held pet tracks the pointer, and remembers how fast it was being moved */
  function dragPet(world, pet, dt) {
    const pw = petWidth(pet);
    const g = world.grab;
    const nx = clamp(world.mouse.x - g.dx, 6, Math.max(6, world.w - pw - 6));
    const nlift = clamp(floorY(world) - (world.mouse.y + g.dy), 0, liftCeiling(world, pet));

    if (dt > 0) {
      // smoothed: one jittery frame should not decide where a fling ends up
      pet.vx = pet.vx * 0.6 + clamp((nx - pet.x) / dt, -THROW_MAX, THROW_MAX) * 0.4;
      pet.vy = pet.vy * 0.6 + clamp((pet.lift - nlift) / dt, -THROW_MAX, THROW_MAX) * 0.4;
    }
    if (Math.abs(nx - pet.x) > 0.5) {
      pet.dir = pet.fdir = nx > pet.x ? 1 : -1; // facing wherever it is being pulled
    }
    pet.x = nx;
    pet.lift = nlift;
    // swing it about and it fights harder, which is the whole reason the throw
    // speed is tracked at all rather than only sampled at the release
    updateSquirm(world, pet, dt, (Math.abs(pet.vx) + Math.abs(pet.vy)) / 700);
  }

  /* let go, and gravity has it back */
  function fallPet(world, pet, dt) {
    const pw = petWidth(pet);
    pet.vy += DROP_GRAVITY * dt;
    pet.lift -= pet.vy * dt;
    pet.x = clamp(pet.x + pet.vx * dt, 6, Math.max(6, world.w - pw - 6));
    pet.vx *= Math.max(0, 1 - 2.4 * dt);
    updateSquirm(world, pet, dt, 0); // still flailing on the way down
    if (pet.lift > 0) return;

    pet.lift = 0; pet.vx = 0; pet.vy = 0;
    pet.squirm = 0; pet.tilt = 0; // back on its feet, and upright again
    for (let i = 0; i < LAND_DUST; i++) {
      spawnParticle(world, {
        x: pet.x + rand(0, pw), y: floorY(world) - 4,
        rect: true, color: '#7c5433', vx: rand(-50, 50), vy: -rand(20, 60),
        life: 0.5, size: 2,
      });
    }
    // back on its feet — the fish just floats again, everyone else takes a beat
    pet.state = pet.kind === 'heisenbug' ? 'swim' : 'sit';
    pet.stateT = rand(0.5, 1.1);
  }

  /*
   * Stop holding whatever is held, and say what it was.
   *
   * Called from the release, and from every way a drag can end without one:
   * the pointer leaving the document, and a pet being taken off screen by its
   * session ending mid-carry.
   */
  function releaseGrab(world) {
    const g = world.grab;
    if (!g) return null;
    world.grab = null;
    if (g.moved) g.pet.state = 'falling';
    return g;
  }

  function startDeadlock(world, a, b) {
    world.deadlock = { a, b, t: 3.2 };
    a.state = 'deadlock'; b.state = 'deadlock';
    a.dir = b.x > a.x ? 1 : -1; b.dir = -a.dir;
    say(world, a, 'i had this spot first.', 3);
    say(world, b, 'lock contention detected', 3);
  }

  function updateDeadlock(world, dt) {
    world.deadlockCd -= dt;
    const d = world.deadlock;
    if (!d) return;
    d.t -= dt;
    if (Math.random() < 0.05) {
      const m = (d.a.x + d.b.x) / 2 + petWidth(d.a) / 2;
      spawnParticle(world, { x: m, y: floorY(world) - 56, glyph: '⏳', color: '#ffb03a', vy: -6, life: 1 });
    }
    if (d.t <= 0) {
      const loser = Math.random() < 0.5 ? d.a : d.b;
      const winner = loser === d.a ? d.b : d.a;
      loser.state = 'walk'; loser.stateT = 2; loser.dir = loser.x > winner.x ? 1 : -1;
      loser.x += loser.dir * 14;
      winner.state = 'walk'; winner.stateT = 0.1;
      say(world, loser, "preempted. this isn't over.", 2.5);
      world.deadlock = null;
      world.deadlockCd = rand(24, 48);
    }
  }

  // --------------------------------------------------------------- the ball
  function updateBall(world, dt) {
    const ball = world.ball, fy = floorY(world);
    if (ball.held) {
      const pet = ball.held, pw = petWidth(pet);
      ball.x = pet.dir === 1 ? pet.x + pw - 2 : pet.x + 2;
      ball.y = fy - pet.sprites.walk1.length * pet.scale * 0.55;
      ball.vx = 0; ball.vy = 0;
      return;
    }
    ball.vy += 620 * dt;
    ball.y += ball.vy * dt;
    if (ball.y >= fy - 5) {
      ball.y = fy - 5;
      ball.vy = Math.abs(ball.vy) > 60 ? -ball.vy * 0.45 : 0;
    }
    ball.x += ball.vx * dt;
    ball.vx *= Math.max(0, 1 - 1.8 * dt);
    if (ball.x < 10) { ball.x = 10; ball.vx = Math.abs(ball.vx) * 0.7; }
    if (ball.x > world.w - 10) { ball.x = world.w - 10; ball.vx = -Math.abs(ball.vx) * 0.7; }
  }

  // ------------------------------------------------- the fish (helmet unit)
  function updateFish(world, pet, dt) {
    const pw = petWidth(pet);
    pet.fy = Math.sin(world.time * 2.2) * 6;

    // Heisenbug is the usage tracker: the heavier the token burn, the more
    // agitated she gets — and she announces every dollar you didn't watch.
    const u = world.usage;
    const burn = u ? (u.burnPerMin || 0) : 0;
    const agitation = 1 + Math.min(2.5, burn / 8000);
    if (u && Math.floor(u.cost) > world.costMilestone) {
      world.costMilestone = Math.floor(u.cost);
      say(world, pet, pick(USAGE_LINES).replace('$COST', '$' + u.cost.toFixed(2)), 3.2);
    }
    if (burn > 4000 && Math.random() < 0.01) {
      spawnParticle(world, { x: pet.x + pw / 2, y: floorY(world) - 62, glyph: '💸', color: '#7ddb63', vy: -12, life: 1.2 });
    }

    if (world.observed || !world.mischief) {
      if (pet.flipped) {
        pet.flipped = false;
        say(world, pet, pick(HEISENBUG_ALIBIS), 2.4);
      }
      pet.x += pet.speed * agitation * pet.fdir * dt;
    } else {
      pet.flipped = true;
      pet.teleportT -= dt;
      pet.x += pet.speed * 2 * pet.fdir * dt;
      if (pet.teleportT <= 0) {
        pet.teleportT = rand(8, 20);
        pet.x = rand(10, Math.max(30, world.w - pw - 10));
        pet.fdir *= -1;
        world.anomalies++;
        spawnParticle(world, { x: pet.x + pw / 2, y: floorY(world) - 60, glyph: '?', color: '#b06bff', vy: -10, life: 0.8 });
      }
    }
    if (pet.x < 8) { pet.x = 8; pet.fdir = 1; }
    if (pet.x > world.w - pw - 8) { pet.x = world.w - pw - 8; pet.fdir = -1; }

    // the helmet holds a little air; bubbles escape anyway
    if (Math.random() < 0.015) {
      spawnParticle(world, {
        x: pet.x + pw / 2, y: floorY(world) - 58,
        glyph: '°', color: '#9fd8ff', vy: -16, life: 1.4,
      });
    }
  }

  // ---------------------------------------------------------------- drawing
  function drawHat(ctx, x, y, scale) {
    ctx.fillStyle = '#ff5f9e';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 5 * scale, y);
    ctx.lineTo(x + 2.5 * scale, y - 6 * scale);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffd75e';
    ctx.fillRect(x + 1.7 * scale, y - 7 * scale, 1.6 * scale, 1.6 * scale);
  }

  /*
   * Turn everything drawn until the matching restore() about a point.
   *
   * The caller owns that restore, and every caller pairs it in the same
   * function — an unbalanced save here would not spoil one frame, it would
   * leave every later frame drawn at an angle, which is why draw() re-applies
   * the base transform rather than trusting the stack.
   */
  function tiltAbout(ctx, angle, px, py) {
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);
    ctx.translate(-px, -py);
  }

  /*
   * A lifted pet's shadow stays on the floor and draws in, which is the only
   * thing on screen that says how high it is being held — the lane has no
   * horizon and the sprite alone cannot tell you.
   */
  function liftShadow(pet) {
    return pet.lift > 0 ? Math.max(0.4, 1 - pet.lift / 150) : 1;
  }

  // soft glow in the pet's own colour, Crew-style
  function drawShadow(ctx, cx, y, w, color) {
    const g = ctx.createRadialGradient(cx, y, 2, cx, y, w / 2);
    g.addColorStop(0, hexA(color, 0.34));
    g.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, y, w / 2, 6, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* the last segment of a working directory: the project a session is in */
  function projectOf(cwd) {
    // split on both separators: a Windows cwd contains no forward slashes
  const parts = String(cwd || '').split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  /*
   * Which session a pet is carrying, in as few characters as will fit above it.
   * The name Claude Code gave the conversation says the most; the project it is
   * running in is the fallback, because a transcript always records a cwd and
   * only sometimes records a title.
   */
  function sessionLabel(s) {
    const raw = (s && s.title) || projectOf(s && s.cwd);
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length <= TITLE_CHARS) return text;
    // trimmed before the ellipsis, or a name cut at a word boundary reads as
    // "Redesign the pet …" with a gap where the missing word was
    return text.slice(0, TITLE_CHARS - 1).replace(/\s+$/, '') + '…';
  }

  /* what a session state is called out loud, rather than in the watcher's terms */
  const STATE_WORDS = {
    thinking: 'thinking', tool: 'working', waiting: 'needs you',
    resting: 'resting', done: 'done',
  };

  /*
   * A surface built the way the sprites are: one flat opaque fill, a 1px dark
   * outline, and corners knocked out by a single pixel. No radii and no
   * translucency — the lane floats over whatever window you happen to have open,
   * and a see-through label is only legible over half of them.
   */
  function pixelPlate(ctx, x, y, w, h, fill, edge) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    ctx.fillStyle = edge;
    ctx.fillRect(x + 1, y, w - 2, h);
    ctx.fillRect(x, y + 1, w, h - 2);
    ctx.fillStyle = fill;
    ctx.fillRect(x + 2, y + 1, w - 4, h - 2);
    ctx.fillRect(x + 1, y + 2, w - 2, h - 4);
  }

  /*
   * Where a pet's nameplate sits and what it says.
   *
   * Hovering expands this plate in place instead of raising a second one: three
   * separate boxes over one pet — name, quote, hover — is how the quote ended up
   * drawn straight through the name.
   */
  function plateFor(world, pet, cx, topY) {
    const s = pet.session;
    const hovered = world.hoverPet === pet;
    const bound = s && STATE_GLYPHS[s.state];
    // An unbound pet is just wandering and carries no label — until you point at
    // it, when it should still be able to say who it is and that it has no
    // session, which is the whole reason it has no name.
    if (!bound && !hovered) return null;

    const ctx = world.ctx;
    const glyph = bound ? STATE_GLYPHS[s.state] : '';
    const name = bound ? (world.showTitles ? sessionLabel(s) : '') : pet.name;
    const detail = hovered ? hoverLine(world, pet) : '';

    ctx.font = FONT;
    const lead = glyph ? GLYPH_BOX : PLATE_PAD;
    const nameW = name ? ctx.measureText(name).width + PLATE_PAD : 0;
    const detailW = detail ? ctx.measureText(detail).width : 0;
    const w = Math.max(lead + nameW, detailW + PLATE_PAD * 2, GLYPH_BOX + PLATE_PAD);
    const h = detail ? PLATE_H + LINE_H : PLATE_H;
    const x = clamp(cx - w / 2, 4, Math.max(4, world.w - w - 4));
    return {
      x, y: topY - PLATE_GAP - h, w, h,
      glyph, name, detail, lead, state: bound ? s.state : null,
    };
  }

  function drawNameplate(world, pet, box) {
    const ctx = world.ctx;
    pixelPlate(ctx, box.x, box.y, box.w, box.h, PLATE, EDGE);
    ctx.font = FONT;
    if (box.glyph) {
      ctx.textAlign = 'center';
      ctx.fillStyle = box.state === 'waiting' ? WAIT_INK
        : box.state === 'done' ? DONE_INK : INK;
      ctx.fillText(box.glyph, box.x + GLYPH_BOX / 2, box.y + 13);
    }
    if (box.name) {
      ctx.textAlign = 'left';
      ctx.fillStyle = INK;
      ctx.fillText(box.name, box.x + box.lead, box.y + 13);
    }
    if (box.detail) {
      ctx.textAlign = 'left';
      ctx.fillStyle = INK_DIM;
      ctx.fillText(box.detail, box.x + PLATE_PAD, box.y + 14 + LINE_H);
    }
  }

  /*
   * The second line, revealed on hover. It must not restate the first: the name
   * is already up there, so this is what the name cannot tell you — where the
   * session is running and what it is doing. The session id used to be here and
   * is gone: it is not something anyone recognises or can act on.
   */
  function hoverLine(world, pet) {
    if (pet.kind === 'heisenbug' && world.usage) {
      const u = world.usage;
      return fmtTokens(u.input + u.output + u.cacheRead + u.cacheWrite) +
        ' tok · ~$' + u.cost.toFixed(2) + ' today';
    }
    const s = pet.session;
    if (!s) return 'no session';
    const parts = [];
    const where = projectOf(s.cwd);
    if (where) parts.push(where);
    parts.push(STATE_WORDS[s.state] || s.state);
    /*
     * Two sessions open in the same repo look identical on a plate that can
     * only show the project, so a click cannot be aimed. A titled session is
     * already distinguishable by its title; an untitled one needs the id, which
     * is the one place it earns its space.
     */
    if (!s.title && s.id) parts.push(String(s.id).slice(0, 8));
    return parts.join(' · ');
  }

  function drawPet(world, pet) {
    const ctx = world.ctx, s = pet.scale;
    const fy = floorY(world);

    if (pet.kind === 'heisenbug') return drawFish(world, pet);

    let grid;
    switch (pet.state) {
      // a carried pet keeps cycling its walk frames, which reads as legs
      // paddling in the air — exactly what a picked-up cat does
      case 'walk': case 'fetch': case 'held': case 'falling':
        grid = pet.frame ? pet.sprites.walk2 : pet.sprites.walk1; break;
      case 'sit': case 'deadlock': grid = pet.sprites.sit || pet.sprites.walk1; break;
      case 'sleep': grid = pet.sprites.sleep || pet.sprites.sit; break;
      case 'loaf': grid = CAT.sleep; break;
      case 'sniff': grid = DOG.sniff; break;
      case 'dig': grid = pet.frame ? DOG.dig : DOG.sniff; break;
      case 'glitch': grid = pet.frame ? CAT.walk1 : CAT.walk2; break;
      case 'crashed': grid = CAT.crashed; break;
      default: grid = pet.sprites.walk1;
    }

    const h = grid.length * s, w = grid[0].length * s;
    const y = fy - h - pet.lift + pet.bob;
    drawShadow(ctx, pet.x + w / 2, fy + 3, w * 0.9 * liftShadow(pet), pet.pal[2] || '#666');

    // a struggling pet is held by the scruff, so that is what it turns about.
    // Its chrome is not: the nameplate is drawn from spriteTop in a later pass
    // and stays upright, because a label swinging with the pet is unreadable.
    const twisting = pet.tilt !== 0;
    if (twisting) tiltAbout(ctx, pet.tilt, pet.x + w / 2, y + h * 0.25);

    if (pet.state === 'glitch') {
      ctx.globalAlpha = 0.5;
      drawGrid(ctx, grid, GLITCH_RED, pet.x + rand(-3, 3), y, s, pet.dir === -1);
      drawGrid(ctx, grid, GLITCH_BLUE, pet.x + rand(-3, 3), y + rand(-2, 2), s, pet.dir === -1);
      ctx.globalAlpha = 1;
      drawGrid(ctx, grid, pet.pal, pet.x, y, s, pet.dir === -1, true);
    } else {
      drawGrid(ctx, grid, pet.pal, pet.x, y, s, pet.dir === -1);
    }

    if (pet.hat && pet.state !== 'crashed' && pet.state !== 'glitch') {
      const hx = pet.dir === -1 ? pet.x + w * 0.14 : pet.x + w * 0.6;
      drawHat(ctx, hx, y + 0.5 * s, s * 0.9);
    }
    if (twisting) ctx.restore(); // the hat goes with the head; the label does not

    if (pet.state === 'deadlock' && Math.floor(world.time * 2) % 2 === 0) {
      drawLabel(world, pet.x + w / 2, y + h / 2 + 8, '🔒');
    }
    pet.spriteTop = y;
    pet.plateAt = pet.x + w / 2;
  }

  function drawFish(world, pet) {
    const ctx = world.ctx, s = pet.scale;
    const fy = floorY(world);
    const grid = pet.frame ? FISH.swim2 : FISH.swim1;
    const fw = grid[0].length * s, fh = grid.length * s;
    const x = pet.x;
    const y = fy - fh - FISH_HOVER - pet.lift + pet.fy;

    drawShadow(ctx, x + fw / 2, fy + 3, fw * 1.1 * liftShadow(pet), pet.pal[2]);

    ctx.save();
    if (!world.observed) { // upside down, obviously
      ctx.translate(x + fw / 2, y + fh / 2);
      ctx.rotate(Math.PI);
      ctx.translate(-(x + fw / 2), -(y + fh / 2));
    }
    // she has no scruff to be held by, so she thrashes about her middle —
    // inside the flip, so being carried while unobserved does both
    if (pet.tilt) {
      ctx.translate(x + fw / 2, y + fh / 2);
      ctx.rotate(pet.tilt);
      ctx.translate(-(x + fw / 2), -(y + fh / 2));
    }
    drawGrid(ctx, grid, pet.pal, x, y, s, pet.fdir === -1);

    // the helmet — like the kid in Wonder. a pixel glass dome over the head.
    const hs = Math.max(2, Math.round(s * 0.75));
    const hw = HELMET_GRID[0].length * hs;
    const hcx = x + (pet.fdir === 1 ? fw * 0.66 : fw * 0.34);
    const hcy = y + fh * 0.42;
    drawGrid(ctx, HELMET_GRID, world.observed ? HELMET_CALM : HELMET_SPOOKED,
      hcx - hw / 2, hcy - hw / 2, hs, pet.fdir === -1);
    ctx.restore();

    if (pet.hat) drawHat(ctx, x + fw / 2 - 3 * 2.6, y - fh * 0.72, 2.6);
    pet.spriteTop = y - 8;
    pet.plateAt = x + fw / 2;
  }

  function drawBall(world) {
    const b = world.ball;
    if (b.held) return; // it's in Grep's mouth
    drawGrid(world.ctx, BALL_GRID, BALL_PAL, b.x - 4, b.y - 4, 2, false);
  }

  function drawCarriedBall(world, pet) {
    const b = world.ball;
    if (b.held !== pet) return;
    drawGrid(world.ctx, BALL_GRID, BALL_PAL, b.x - 4, b.y - 4, 2, false);
  }

  function drawLabel(world, cx, y, text) {
    const ctx = world.ctx;
    ctx.font = FONT;
    const w = ctx.measureText(text).width + PLATE_PAD * 2;
    const x = clamp(cx - w / 2, 4, world.w - w - 4);
    pixelPlate(ctx, x, y - 16, w, PLATE_H, PLATE, EDGE);
    ctx.fillStyle = INK;
    ctx.textAlign = 'left';
    ctx.fillText(text, x + PLATE_PAD, y - 3);
  }

  /*
   * A pet talking, in the pet's own light tone.
   *
   * It used to be white, which failed twice over: it was the loudest thing in
   * the lane for the least important thing in it, and over a light window there
   * was no bubble to see at all. Taking the fill from the speaker's palette
   * makes it legible on any backdrop and says who is talking without a tail
   * having to be traced.
   *
   * It sits above the nameplate rather than across it — chromeTop is where the
   * pet's own chrome ended this frame.
   */
  function drawBubble(world, b) {
    const ctx = world.ctx;
    const pet = b.pet;
    const cx = pet.x + petWidth(pet) / 2;
    const alpha = b.age < 0.15 ? b.age / 0.15
      : b.age > b.life - 0.3 ? Math.max(0, (b.life - b.age) / 0.3) : 1;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = FONT;
    const w = ctx.measureText(b.text).width + PLATE_PAD * 2;
    const h = PLATE_H;
    const x = clamp(cx - w / 2, 4, Math.max(4, world.w - w - 4));
    const top = (pet.chromeTop != null ? pet.chromeTop : floorY(world) - 58) - SPEECH_GAP - TAIL_H - h;
    const fill = (pet.pal && pet.pal[1]) || '#e8ebf2';

    pixelPlate(ctx, x, top, w, h, fill, EDGE);

    // a pixel staircase for the tail, drawn in the same two colours
    const tx = Math.round(clamp(cx, x + 8, x + w - 8));
    for (let i = 0; i < TAIL_H; i++) {
      const half = TAIL_H - i;
      ctx.fillStyle = EDGE;
      ctx.fillRect(tx - half - 1, top + h + i, (half + 1) * 2, 1);
      ctx.fillStyle = fill;
      ctx.fillRect(tx - half, top + h + i, half * 2, 1);
    }

    ctx.fillStyle = EDGE;
    ctx.textAlign = 'left';
    ctx.fillText(b.text, x + PLATE_PAD, top + 13);
    ctx.restore();
  }


  // ------------------------------------------------------------------ loop
  /*
   * One throw in here used to end the animation for good: the frame that threw
   * never reached the requestAnimationFrame at the bottom, so the lane froze on
   * whatever had been painted so far — half a pet, or a shadow with no cat above
   * it — with nothing on screen to say why. It has happened three times now (a
   * missing sprite fallback, a missing state, an exhausted sprite cache), so the
   * re-arm is unconditional and a bad frame costs one frame. The console is the
   * only place left to say so; it is rate-limited because a permanent fault
   * would otherwise write sixty lines a second.
   */
  function tick(world, now) {
    if (world.destroyed) return;
    try {
      const dt = Math.min(0.05, (now - (world.lastNow || now)) / 1000);
      world.lastNow = now;
      stepWorld(world, dt, now);
      draw(world);
    } catch (err) {
      if (world.badFrames++ % 300 === 0) console.error('strays: bad frame', err);
    } finally {
      if (!world.destroyed) world.raf = requestAnimationFrame((n) => tick(world, n));
    }
  }

  // A pet holds its session for as long as that session id is still being
  // emitted. The watcher re-sorts its list by most-recent-activity, so anything
  // positional would hand a pet a different session the moment another one got
  // busy — and the pet you aim at would not be the pet you click.
  function bindSessions(world, assignable) {
    const live = new Map();
    for (const s of world.sessions) if (s && !live.has(s.id)) live.set(s.id, s);

    const held = new Set();
    for (const p of assignable) {
      const id = p.session ? p.session.id : null;
      if (p.session && live.has(id) && !held.has(id)) {
        p.session = live.get(id); // same session, fresh state
        held.add(id);
      } else {
        p.session = null;
      }
    }

    // whatever is left is new, and takes the first free pet in the existing
    // order: land pets first, the fish only if we run out
    let next = 0;
    for (const s of live.values()) {
      if (held.has(s.id)) continue;
      while (next < assignable.length && assignable[next].session) next++;
      if (next >= assignable.length) break;
      assignable[next].session = s;
    }

    // in follow mode the team size matches the session count (Crew-style: one
    // creature per session) — with zero sessions everyone hangs out
    const follow = world.followMode && world.sessions.length > 0;
    for (const p of assignable) p.hidden = follow && !p.session;
  }

  function stepWorld(world, dt, now) {
    world.time += dt;

    /*
     * Is anyone watching? Heisenbug only misbehaves when nobody is.
     *
     * On a web page "a mousemove landed on the canvas recently" is a fair proxy
     * for that. In the desktop overlay it is exactly backwards: the canvas is a
     * 190px strip along the bottom of the screen that you almost never point at,
     * so a developer sitting there working all day never registers, and the fish
     * spends the entire session teleporting across the screen. The overlay
     * therefore supplies the answer itself, from system-wide idle time.
     */
    const mouseRecent = now - world.lastMouseMove < 6000;
    const watched = world.observedOverride != null ? world.observedOverride : mouseRecent;
    world.observed = !document.hidden && watched;

    // sessions -> pets, land pets first, the fish only if we run out
    const assignable = world.pets.filter((p) => p.kind !== 'heisenbug')
      .concat(world.pets.filter((p) => p.kind === 'heisenbug'));
    bindSessions(world, assignable);
    if (world.ball.held && world.ball.held.hidden) {
      world.ball.held = null;
      world.ball.vy = 0;
    }
    if (world.deadlock && (world.deadlock.a.hidden || world.deadlock.b.hidden)) {
      world.deadlock.a.state = 'walk'; world.deadlock.b.state = 'walk';
      world.deadlock = null;
    }
    // a session ending mid-carry takes its pet off screen, and a hidden pet is
    // never updated again: the grab has to end here or the pointer keeps a pet
    // nobody can see, and the next release would answer for it
    if (world.grab && world.grab.pet.hidden) releaseGrab(world);

    updateDeadlock(world, dt);
    updateBall(world, dt);
    for (const p of world.pets) if (!p.hidden) updatePet(world, p, dt);

    world.particles = world.particles.filter((p) => (p.age += dt) < p.life);
    for (const p of world.particles) { p.x += (p.vx || 0) * dt; p.y += p.vy * dt; }

    world.bubbles = world.bubbles.filter((bb) => (bb.age += dt) < bb.life);

    if (world.opts.party && world.confetti.length < 80 && Math.random() < 0.3) {
      world.confetti.push({
        x: rand(0, world.w), y: -10, vy: rand(30, 80), vx: rand(-20, 20),
        color: pick(['#ff5f9e', '#ffd75e', '#57c7ff', '#7ddb63', '#b06bff']),
        rot: rand(0, 6), vr: rand(-3, 3), age: 0,
      });
    }
    for (const c of world.confetti) {
      c.x += c.vx * dt; c.y += c.vy * dt; c.rot += c.vr * dt;
      c.x += Math.sin(world.time * 2 + c.rot) * 12 * dt;
    }
    world.confetti = world.confetti.filter((c) => c.y < world.h + 12);
  }

  function draw(world) {
    const ctx = world.ctx;
    // The base transform, re-applied rather than assumed. Pets are drawn turned
    // now, and a save/restore that a throw got between would otherwise leave the
    // whole lane tilted for good instead of for one frame.
    ctx.setTransform(world.dpr, 0, 0, world.dpr, 0, 0);
    ctx.clearRect(0, 0, world.w, world.h);

    // Resolved before anything is drawn, because a pet's own nameplate is what
    // expands on hover — there is no second label raised afterwards.
    world.hoverPet = hitTest(world, world.mouse.x, world.mouse.y);

    drawBall(world);
    for (const p of world.pets) {
      if (p.hidden) continue;
      drawPet(world, p);
      drawCarriedBall(world, p);
    }

    for (const p of world.particles) {
      const a = 1 - p.age / p.life;
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      if (p.rect) {
        ctx.fillRect(p.x, p.y, p.size, p.size);
      } else {
        ctx.font = '13px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(p.glyph, p.x, p.y);
      }
      ctx.globalAlpha = 1;
    }

    for (const c of world.confetti) {
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.fillStyle = c.color;
      ctx.fillRect(-3, -2, 6, 4);
      ctx.restore();
    }

    /*
     * Chrome last, and in one pass. A drifting particle drawn over a session
     * name is the same failure as the quote that used to cover it: the label
     * has to be readable at a glance or it is not doing its job.
     */
    for (const p of world.pets) {
      if (p.hidden) continue;
      const box = plateFor(world, p, p.plateAt, p.spriteTop);
      // where this pet's chrome ends, so anything it says can sit above it
      p.chromeTop = box ? box.y : p.spriteTop;
      if (box) drawNameplate(world, p, box);
    }
    for (const bb of world.bubbles) drawBubble(world, bb);
  }


  function hitTest(world, mx, my) {
    /*
     * Backwards, because pets are drawn in array order and two of them do
     * overlap: the last one drawn is the one on top, and so the one you are
     * pointing at. Forwards returns the pet *behind* the one you can see, which
     * a click could get away with and carrying one cannot.
     */
    for (let i = world.pets.length - 1; i >= 0; i--) {
      const p = world.pets[i];
      if (p.hidden) continue;
      const pw = petWidth(p);
      if (mx < p.x - 6 || mx > p.x + pw + 6) continue;
      // a pet is caught anywhere in the bottom of the lane, and takes that band
      // up with it when it is carried — otherwise lifting one out of the band
      // drops it, since the pointer would no longer be over anything
      if (my >= world.h - 110 - p.lift) return p;
    }
    return null;
  }

  // ---------------------------------------------------------------- storage
  const STORE_KEY = 'strays.custom';

  function loadStoredCustoms() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(validCustom) : [];
    } catch { return []; }
  }

  function validCustom(def) {
    return def && def.grids && Array.isArray(def.grids.walk1) && def.grids.walk1.length > 0 &&
           def.palette && typeof def.palette === 'object';
  }

  // ----------------------------------------------------------------- mount
  function mount(userOpts) {
    const opts = Object.assign({
      height: 170,
      scale: 4,
      pets: ['segfault', 'grep', 'mutex', 'heisenbug'],
      customPets: [],       // extra pet defs (see editor.html)
      loadStored: true,     // also load pets adopted via editor.html (localStorage)
      party: false,
      zIndex: 2147483000,
      parent: document.body,
      onHoverChange: null,  // (hovering:boolean) — used by the desktop overlay
      onPetClick: null,     // (session) — tap a pet, jump to its session
    }, userOpts || {});

    const world = createWorld(opts);
    const canvas = document.createElement('canvas');
    canvas.setAttribute('data-strays', '');
    Object.assign(canvas.style, {
      position: 'fixed', left: '0', bottom: '0', width: '100vw',
      height: opts.height + 'px', zIndex: String(opts.zIndex),
      pointerEvents: 'none', imageRendering: 'pixelated',
    });
    opts.parent.appendChild(canvas);
    world.canvas = canvas;
    world.ctx = canvas.getContext('2d');

    const customDefs = opts.customPets.concat(opts.loadStored ? loadStoredCustoms() : []).filter(validCustom);

    function spread() {
      const total = opts.pets.length + customDefs.length;
      world.pets = [];
      let i = 0;
      const place = () => clamp((world.w / (total + 1)) * (++i) - 30 + rand(-40, 40), 10, Math.max(20, world.w - 110));
      for (const kind of opts.pets) world.pets.push(makePet(world, kind, place()));
      for (const def of customDefs) world.pets.push(makeCustomPet(world, def, place()));
      world.ball.x = world.w * 0.5;
      world.ball.y = floorY(world) - 5;
    }

    function resize() {
      const oldW = world.w;
      world.dpr = Math.min(2, window.devicePixelRatio || 1);
      world.w = canvas.clientWidth || window.innerWidth;
      world.h = opts.height;
      canvas.width = world.w * world.dpr;
      canvas.height = world.h * world.dpr;
      world.ctx.setTransform(world.dpr, 0, 0, world.dpr, 0, 0);
      if (!world.pets.length) {
        if (world.w > 0) spread();
      } else if (oldW > 0 && world.w > 0 && oldW !== world.w) {
        const k = world.w / oldW;
        for (const p of world.pets) p.x *= k;
        world.ball.x *= k;
      }
    }
    resize();
    window.addEventListener('resize', resize);

    let wasHover = false;
    let hoverTimeout = 0;
    function setHover(hov) {
      if (hov !== wasHover) {
        wasHover = hov;
        if (opts.onHoverChange) opts.onHoverChange(hov);
      }
    }
    function onMove(e) {
      const r = canvas.getBoundingClientRect();
      world.mouse.x = e.clientX - r.left;
      world.mouse.y = e.clientY - r.top;
      world.lastMouseMove = performance.now();

      const g = world.grab;
      if (g && !g.moved &&
          Math.abs(world.mouse.x - g.x0) + Math.abs(world.mouse.y - g.y0) > DRAG_SLOP) {
        g.moved = true;
        grabPet(world, g.pet);
      }

      /*
       * A drag holds the lane whatever the pointer is over.
       *
       * The overlay makes its window click-through the moment nothing is
       * hovered, and it is the same window the release has to arrive at. Let
       * hover go false mid-carry — by lifting a pet clear of the pointer, or by
       * simply holding still for the timeout below — and the mouseup is
       * delivered to whatever is underneath instead, leaving a pet stuck to the
       * cursor with no way to put it down.
       */
      setHover(!!g || !!hitTest(world, world.mouse.x, world.mouse.y));
      clearTimeout(hoverTimeout);
      if (!g) hoverTimeout = setTimeout(() => onLeave(), 2500);
    }
    function onLeave() {
      releaseGrab(world); // the pointer is gone, so no release is coming
      world.mouse.x = -9999; world.mouse.y = -9999; world.mouse.active = false;
      setHover(false);
    }
    function onDown() {
      world.mouse.active = true;
      const pet = hitTest(world, world.mouse.x, world.mouse.y);
      // a press is only a candidate: what makes it a drag is travelling, and
      // what makes it a click is not
      if (pet) world.grab = { pet, moved: false, x0: world.mouse.x, y0: world.mouse.y, dx: 0, dy: 0 };
    }
    function onUp() {
      world.mouse.active = false;
      const g = releaseGrab(world);
      if (g && !g.moved && g.pet.session && opts.onPetClick) opts.onPetClick(g.pet.session);
      setHover(!!hitTest(world, world.mouse.x, world.mouse.y));
    }
    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('mousedown', onDown, { passive: true });
    window.addEventListener('mouseup', onUp, { passive: true });
    document.addEventListener('mouseleave', onLeave);

    world._cleanup = () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      document.removeEventListener('mouseleave', onLeave);
      clearTimeout(hoverTimeout);
      canvas.remove();
    };

    world.raf = requestAnimationFrame((n) => tick(world, n));
    Strays._world = world;
    return world;
  }

  // ------------------------------------------------------------------- API
  const Strays = {
    mount,
    setStatus(s) { if (this._world) this._world.status = s; },
    // per-session states from the desktop watcher:
    // [{ id, state: 'thinking'|'tool'|'waiting'|'done', cwd, title? }]
    setSessions(list) { if (this._world) this._world.sessions = Array.isArray(list) ? list : []; },
    // whether a pet names the session it is carrying, or just shows its state
    setShowTitles(on) { if (this._world) this._world.showTitles = !!on; },
    /*
     * Tell the engine whether anyone is actually watching, when the host can
     * answer that better than a mousemove on the canvas can. Pass null to go
     * back to working it out from the pointer.
     */
    setObserved(on) {
      if (this._world) this._world.observedOverride = on == null ? null : !!on;
    },
    // whether Heisenbug wanders off while nobody is looking
    setMischief(on) { if (this._world) this._world.mischief = !!on; },
    // one visible pet per session (used by the desktop overlay); with zero
    // sessions the whole team stays out
    setFollowMode(on) { if (this._world) this._world.followMode = !!on; },
    // horizontal centre of the visible pet holding a session, or null when no
    // pet does. The overlay raises approval cards here, so the card and the
    // clickable pet can never disagree about who asked.
    sessionAnchor(id) {
      const w = this._world;
      if (!w || id == null) return null;
      const pet = w.pets.find((p) => p.session && p.session.id === id);
      return pet ? pet.x + petWidth(pet) / 2 : null;
    },
    // today's token usage — Heisenbug reacts to it and shows it on hover.
    // { input, output, cacheRead, cacheWrite, cost, burnPerMin }
    setUsage(stats) {
      const w = this._world;
      if (!w || !stats) return;
      if (w.costMilestone === null) w.costMilestone = Math.floor(stats.cost || 0);
      w.usage = stats;
    },
    setParty(on) {
      if (this._world) {
        this._world.opts.party = on;
        for (const p of this._world.pets) p.hat = on;
      }
    },
    // a short confetti burst + happy pets (e.g. when a Claude session finishes)
    celebrate() {
      const w = this._world;
      if (!w) return;
      for (let i = 0; i < 60; i++) {
        w.confetti.push({
          x: rand(0, w.w), y: rand(-40, -5), vy: rand(60, 130), vx: rand(-30, 30),
          color: pick(['#ff5f9e', '#ffd75e', '#57c7ff', '#7ddb63', '#b06bff']),
          rot: rand(0, 6), vr: rand(-4, 4), age: 0,
        });
      }
      for (const p of w.pets) {
        if (p.kind !== 'heisenbug' && p.state !== 'crashed' && p.state !== 'glitch') {
          p.state = 'walk'; p.stateT = rand(2, 4);
        }
      }
    },
    // live-add a custom pet; persist=true also saves it for future mounts
    addCustomPet(def, persist) {
      if (!validCustom(def)) throw new Error('strays: invalid pet def (needs grids.walk1 + palette)');
      const w = this._world;
      if (w) w.pets.push(makeCustomPet(w, def, rand(20, Math.max(40, w.w - 120))));
      if (persist) {
        const all = loadStoredCustoms().filter((d) => d.name !== def.name);
        all.push(def);
        try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch { /* private mode */ }
      }
    },
    removeCustomPet(name) {
      const w = this._world;
      if (w) w.pets = w.pets.filter((p) => !(p.custom && p.name === name));
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(loadStoredCustoms().filter((d) => d.name !== name)));
      } catch { /* private mode */ }
    },
    listCustomPets: loadStoredCustoms,
    // render a grid+palette to a canvas with the Crew-style outline (editor uses this)
    renderSprite: renderSpriteCanvas,
    destroy() {
      if (this._world) {
        this._world.destroyed = true;
        cancelAnimationFrame(this._world.raf);
        this._world._cleanup();
        this._world = null;
      }
    },
    // advance the simulation manually (testing / hidden tabs)
    step(dt, frames) {
      const w = this._world;
      if (!w) return;
      for (let i = 0; i < (frames || 1); i++) {
        stepWorld(w, dt || 1 / 60, performance.now());
      }
      draw(w);
    },
    _world: null,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Strays;
  global.Strays = Strays;

  // auto-mount when loaded with data-auto attribute
  if (typeof document !== 'undefined') {
    const me = document.currentScript;
    if (me && me.hasAttribute('data-auto')) {
      const party = me.hasAttribute('data-party');
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => mount({ party }));
      } else mount({ party });
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
