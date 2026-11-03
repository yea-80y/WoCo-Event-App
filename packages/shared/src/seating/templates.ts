/**
 * Starting layouts ("Start from a layout") and the small constructors the builder
 * shares with them. Bands carry names only; prices are set per event.
 */

import {
  SEAT_LAYOUT_FORMAT,
  type LayoutSeat,
  type RowsItem,
  type SeatBand,
  type SeatLayout,
  type ShapeItem,
  type ShapeKind,
  type TableItem,
  type TableShape,
} from "./layout.js";

/**
 * Row names from `first`: A, B, C ... then AA, BB ... past Z, skipping I and O
 * when asked (they read as 1 and 0). A number starts numbered rows.
 */
export function rowLetters(first: string, n: number, skipIO = true): string[] {
  const f = String(first || "A").trim().toUpperCase();
  const out: string[] = [];
  if (/^\d+$/.test(f)) {
    for (let i = 0; i < n; i++) out.push(String(Number(f) + i));
    return out;
  }
  const doubled = f.length > 1 && f[0] === f[1];
  const letters: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const ch = String.fromCharCode(c);
    if (!(skipIO && (ch === "I" || ch === "O"))) letters.push(ch);
  }
  const all = [...letters, ...letters.map((ch) => ch + ch)];
  let at = all.indexOf(doubled ? f.slice(0, 2) : f[0]);
  if (at < 0) at = 0;
  while (out.length < n && at < all.length) out.push(all[at++]);
  while (out.length < n) out.push(String(out.length + 1));
  return out;
}

/** The `n` row names after `last`. */
export const labelsAfter = (last: string, n: number): string[] => rowLetters(last, n + 1, true).slice(1);

export const normRot = (deg: number): number => ((Math.round(deg) % 360) + 360) % 360;

export const labelWidth = (text: string): number => Math.max(48, Math.round(text.length * 7.6 + 18));

/** Id source for one layout: `i1`, `i2` ... for items, `b1` ... for bands. */
export function idMaker(): (prefix: "i" | "b") => string {
  let n = 0;
  return (prefix) => `${prefix}${++n}`;
}

export function makeRow(label: string, count: number, band: string, aisleAt = 0): { label: string; seats: LayoutSeat[] } {
  const seats: LayoutSeat[] = [];
  for (let i = 0; i < count; i++) {
    if (aisleAt && i === aisleAt) seats.push({ g: true });
    seats.push({ b: band });
  }
  return { label, seats };
}

export function rowsBlock(
  id: string,
  name: string,
  x: number,
  y: number,
  nRows: number,
  nSeats: number,
  band: string,
  first = "A",
  { curve = 0, aisle = true, rot = 0 }: { curve?: number; aisle?: boolean; rot?: number } = {},
): RowsItem {
  return {
    id, kind: "rows", name, x, y, rot: normRot(rot), curve, numberFrom: "left",
    rows: rowLetters(first, nRows, true).map((l) => makeRow(l, nSeats, band, aisle ? Math.ceil(nSeats / 2) : 0)),
  };
}

export function table(id: string, name: string, x: number, y: number, n: number, shape: TableShape, band: string, rot = 0): TableItem {
  return { id, kind: "table", shape, name, x, y, rot: normRot(rot), seats: Array.from({ length: n }, () => ({ b: band })) };
}

export function shape(id: string, kind: ShapeKind, x: number, y: number, w: number, h: number, text: string, rot = 0): ShapeItem {
  return { id, kind, x, y, w: kind === "label" ? labelWidth(text) : w, h, rot: normRot(rot), text };
}

export interface LayoutTemplate {
  id: string;
  name: string;
  description: string;
  make(): SeatLayout;
}

function layout(name: string, bands: SeatBand[], items: SeatLayout["items"]): SeatLayout {
  return { format: SEAT_LAYOUT_FORMAT, name, bands, items };
}

export const LAYOUT_TEMPLATES: readonly LayoutTemplate[] = [
  {
    id: "theatre",
    name: "Theatre",
    description: "Curved stalls, a circle behind",
    make() {
      const id = idMaker();
      const bands = [{ id: id("b"), name: "Stalls", style: 0 }, { id: id("b"), name: "Rear stalls", style: 1 }, { id: id("b"), name: "Circle", style: 2 }];
      const stalls = rowsBlock(id("i"), "Stalls", 650, 210, 12, 22, bands[0].id, "A", { curve: 45 });
      for (const r of stalls.rows.slice(8)) r.seats = r.seats.map((s) => ("g" in s ? s : { b: bands[1].id }));
      const back = stalls.rows[11].seats;
      back[0] = { b: bands[1].id, a: true };
      back[back.length - 1] = { b: bands[1].id, a: true };
      const circle = rowsBlock(id("i"), "Circle", 650, 640, 5, 26, bands[2].id, "AA", { curve: 55 });
      return layout("Theatre", bands, [shape(id("i"), "stage", 650, 70, 420, 50, "Stage"), stalls, circle]);
    },
  },
  {
    id: "cabaret",
    name: "Cabaret",
    description: "Round tables of six facing a stage",
    make() {
      const id = idMaker();
      const bands = [{ id: id("b"), name: "Front tables", style: 0 }, { id: id("b"), name: "Tables", style: 1 }];
      const items: SeatLayout["items"] = [shape(id("i"), "stage", 650, 70, 320, 46, "Stage")];
      let n = 0;
      ([[210, [410, 570, 730, 890]], [330, [330, 490, 650, 810, 970]], [450, [410, 570, 730, 890]]] as const).forEach(([y, xs], line) =>
        xs.forEach((x) => items.push(table(id("i"), `Table ${++n}`, x, y, 6, "round", bands[line === 0 ? 0 : 1].id))));
      items.push(shape(id("i"), "bar", 650, 600, 260, 40, "Bar"));
      return layout("Cabaret", bands, items);
    },
  },
  {
    id: "comedy",
    name: "Comedy club",
    description: "Small tables at the front, rows behind",
    make() {
      const id = idMaker();
      const bands = [{ id: id("b"), name: "Front tables", style: 0 }, { id: id("b"), name: "Seats", style: 1 }];
      const items: SeatLayout["items"] = [shape(id("i"), "stage", 650, 70, 240, 44, "Stage")];
      [440, 545, 650, 755, 860].forEach((x, i) => items.push(table(id("i"), `Table ${i + 1}`, x, 170, 4, "round", bands[0].id)));
      items.push(rowsBlock(id("i"), "Seats", 650, 300, 7, 16, bands[1].id, "A", { curve: 60 }));
      return layout("Comedy club", bands, items);
    },
  },
  {
    id: "gala",
    name: "Gala dinner",
    description: "Tables of ten round a dance floor",
    make() {
      const id = idMaker();
      const bands = [{ id: id("b"), name: "Dinner", style: 0 }];
      const b = bands[0].id;
      const items: SeatLayout["items"] = [shape(id("i"), "stage", 650, 70, 300, 46, "Stage")];
      const top = table(id("i"), "Top table", 650, 165, 12, "head", b);
      top.seats = top.seats.map(() => ({ b, h: true }));
      items.push(top, shape(id("i"), "floor", 650, 340, 260, 170, "Dance floor"));
      let n = 0;
      [[360, 270], [360, 400], [360, 530], [940, 270], [940, 400], [940, 530], [440, 650], [580, 650], [720, 650], [860, 650]]
        .forEach(([x, y]) => items.push(table(id("i"), `Table ${++n}`, x, y, 10, "round", b)));
      items.push(shape(id("i"), "bar", 650, 790, 240, 40, "Bar"));
      return layout("Gala dinner", bands, items);
    },
  },
  {
    id: "stadium",
    name: "Stadium",
    description: "Four stands round a pitch or court, hospitality tables behind the main stand",
    make() {
      const id = idMaker();
      const bands = [
        { id: id("b"), name: "Main stand", style: 0 }, { id: id("b"), name: "Opposite stand", style: 1 },
        { id: id("b"), name: "Ends", style: 2 }, { id: id("b"), name: "Hospitality", style: 3 },
      ];
      const [main, opp, ends, hosp] = bands.map((x) => x.id);
      // Every stand's front row faces the pitch: the far stand is turned round, the ends face inwards.
      const pitch = shape(id("i"), "pitch", 650, 470, 540, 340, "Pitch");
      const south = rowsBlock(id("i"), "Main stand", 650, 670, 8, 26, main);
      const north = rowsBlock(id("i"), "Opposite stand", 650, 270, 8, 26, opp, "A", { rot: 180 });
      for (const st of [south, north]) {
        const a = st.rows[0].seats;
        const band = (a[1] as { b: string }).b;
        a[0] = { b: band, a: true };
        a[a.length - 1] = { b: band, a: true };
      }
      const items: SeatLayout["items"] = [
        pitch, south, north,
        rowsBlock(id("i"), "West end", 350, 470, 8, 14, ends, "A", { rot: 90 }),
        rowsBlock(id("i"), "East end", 950, 470, 8, 14, ends, "A", { rot: -90 }),
      ];
      [470, 590, 710, 830].forEach((x, i) => items.push(table(id("i"), `Table ${i + 1}`, x, 925, 10, "round", hosp)));
      return layout("Stadium", bands, items);
    },
  },
  {
    id: "boxing",
    name: "Boxing night",
    description: "Ringside rows on all four sides, dinner tables round them",
    make() {
      const id = idMaker();
      const bands = [{ id: id("b"), name: "Ringside", style: 0 }, { id: id("b"), name: "Tables", style: 1 }];
      const [ring, tbl] = bands.map((x) => x.id);
      const items: SeatLayout["items"] = [shape(id("i"), "ring", 650, 430, 180, 180, "Ring")];
      ([["North ringside", 650, 300, 180], ["South ringside", 650, 560, 0], ["West ringside", 520, 430, 90], ["East ringside", 780, 430, -90]] as const)
        .forEach(([name, x, y, rot]) => items.push(rowsBlock(id("i"), name, x, y, 2, 8, ring, "A", { aisle: false, rot })));
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        items.push(table(id("i"), `Table ${k + 1}`, Math.round(650 + 320 * Math.cos(a)), Math.round(430 + 320 * Math.sin(a)), 10, "round", tbl));
      }
      items.push(shape(id("i"), "bar", 650, 850, 240, 40, "Bar"));
      return layout("Boxing night", bands, items);
    },
  },
  {
    id: "empty",
    name: "Empty room",
    description: "Just a stage. Build it your way",
    make() {
      const id = idMaker();
      return layout("Empty room", [{ id: id("b"), name: "Standard", style: 0 }], [shape(id("i"), "stage", 650, 70, 320, 46, "Stage")]);
    },
  },
];
