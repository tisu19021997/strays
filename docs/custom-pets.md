# Designing your own pet

Open `editor.html` in a browser:

- paint two walk frames on the pixel grid — a dark outline is added for you — or
  **import a PNG** and it gets quantized onto the grid
- name it, give it things to say, hit **adopt**, and it joins the team on every
  page in that browser
- **export JSON** and save it to `~/.strays/custom-pets.json` so the desktop
  overlay picks it up too (the file holds an array of pet definitions)

## A pet is just JSON

```json
{
  "name": "Nullptr",
  "speed": 30,
  "phrases": ["i am also a bug"],
  "palette": { "1": "#8fd977", "2": "#5cb85c", "3": "#3d8b3d", "k": "#17181c", "w": "#f5f7fb" },
  "grids": {
    "walk1": ["..11..", ".1111k", ".2222.", ".3.3.."],
    "walk2": ["..11..", ".1111k", ".2222.", "3...3."]
  }
}
```

`grids.walk1` and `palette` are required. `walk2`, `sit` and `sleep` are
optional and fall back to `walk1`.

## The grid

Each string is one row of pixels; every row in a grid must be the same length.
`.` is transparent, and every other character is looked up in `palette`.

| char | meaning |
| --- | --- |
| `1` `2` `3` | light, mid and dark body tones |
| `k` | black — eyes and outlines you want to draw yourself |
| `w` | white — the glint in an eye |
| `p` | pink — ears, tongues, noses |
| `s` | stripes or markings |
| `n` | nose |

You are not limited to those: any character you put in `palette` works. The
built-in pets use a 16-wide grid, which is a good size to copy.

A one-pixel dark outline is generated automatically around every sprite, so
grids only carry the fill — don't draw the outline yourself.

## From code

```js
Strays.addCustomPet(def);          // adopt for this page
Strays.addCustomPet(def, true);    // …and remember it in this browser
Strays.listCustomPets();
Strays.removeCustomPet('Nullptr');
```

Adopted pets are stored under the `strays.custom` key in `localStorage`.
